/**
 * ClickHouse `delivery_attempts` logging for the Render delivery service.
 *
 * Mirrors apps/delivery-edge/src/clickhouse-log.ts so the dashboard sees
 * a consistent shape regardless of which runtime delivered an event:
 *   - delivery-edge   → HTTP / R2 / Postgres / S3 destinations (CF Worker)
 *   - delivery-service → MongoDB and other native-driver destinations (Render)
 *
 * Without this, MongoDB deliveries succeed end-to-end but never produce a
 * `delivery_attempts` row, so the dashboard's per-route "Recent events" and
 * "delivery health" panes show "no traffic" even when data is landing in
 * the destination collection.
 *
 * Schema (matches infra/clickhouse/schema.sql):
 *   workspace_id, event_id, route_id, destination_id, attempt_id, attempt_no,
 *   status (success|retry|dead), latency_ms, response_json, created_at
 *
 * Fire-and-forget via the shared `insertRows` helper — we'd rather miss an
 * analytics row than crash the poll loop on a transient ClickHouse outage.
 */

import {
  insertRows,
  toClickhouseDateTime,
  type ClickhouseInsertEnv,
} from "@axel/shared";

export type ClickhouseLogEnv = ClickhouseInsertEnv;

export interface DeliveryAttemptLog {
  workspace_id: string;
  event_id: string;
  route_id: string;
  destination_id: string;
  /** Deterministic id: `${event_id}-${destination_id}-${attempt_no}` matches delivery-edge. */
  attempt_id: string;
  attempt_no: number;
  status: "success" | "retry" | "dead";
  latency_ms: number;
  /**
   * Whether this delivery is test traffic (a test event sent via
   * `/admin/trigger-event`, or a replay of one). MUST be threaded from the
   * queue message: the billing rollup counts `delivery_attempts WHERE
   * attempt_no = 1 AND is_test = false`, so omitting it lets the ClickHouse
   * column default to false and silently bills test deliveries.
   */
  is_test: boolean;
  /** Small structured summary — connector outcome, error message, etc. */
  response: {
    destination_type?: string;
    error?: string;
  } & Record<string, unknown>;
  /** ISO 8601 timestamp; defaults to "now" if omitted. */
  created_at?: string;
}

export async function logDeliveryAttempt(
  env: ClickhouseLogEnv,
  attempt: DeliveryAttemptLog,
): Promise<void> {
  if (!env.CLICKHOUSE_URL) return;

  const row = {
    workspace_id: attempt.workspace_id,
    event_id: attempt.event_id,
    route_id: attempt.route_id,
    destination_id: attempt.destination_id,
    attempt_id: attempt.attempt_id,
    attempt_no: attempt.attempt_no,
    status: attempt.status,
    latency_ms: attempt.latency_ms,
    is_test: attempt.is_test === true,
    response_json: JSON.stringify(attempt.response ?? {}),
    created_at: toClickhouseDateTime(attempt.created_at ?? new Date().toISOString()),
  };

  await insertRows(env, "delivery_attempts", [row]);
}

/** Deterministic attempt id matching the delivery-edge convention. */
export function buildAttemptId(message: {
  event_id: string;
  destination_id: string;
  attempt_no: number;
}): string {
  return `${message.event_id}-${message.destination_id}-${message.attempt_no}`;
}
