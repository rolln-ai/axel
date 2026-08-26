/**
 * ClickHouse `delivery_attempts` logging for the delivery-edge worker.
 *
 * Fire-and-forget single-row insert via the shared `insertRows` helper (we'd
 * rather miss an analytics row than crash a delivery worker on a transient
 * ClickHouse outage).
 *
 * Schema (matches infra/clickhouse/schema.sql):
 *   workspace_id, event_id, route_id, destination_id, attempt_id, attempt_no,
 *   status (success|retry|dead), latency_ms, response_json, created_at
 *
 * The `response_json` field is a small JSON blob describing the outcome —
 * connector type, HTTP status, error message, etc. We deliberately do NOT
 * store the destination's full response body: it can be arbitrary size,
 * may contain customer secrets, and isn't useful for the dashboard's
 * "where did this event sync to" view.
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
  /** Per-attempt id; if the worker doesn't generate one, build it from event+attempt. */
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
  /** Small structured summary — see module docstring. */
  response: {
    destination_type?: string;
    http_status?: number;
    error?: string;
  } & Record<string, unknown>;
  /** ISO 8601 timestamp; defaults to "now" if not supplied. */
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
