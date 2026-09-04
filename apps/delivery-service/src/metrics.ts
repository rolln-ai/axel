/**
 * AXE-32 — Prometheus-shaped metrics endpoint for delivery-service.
 *
 * Exposition format (text-based):
 *   # HELP axel_dead_letters_total ...
 *   # TYPE axel_dead_letters_total gauge
 *   axel_dead_letters_total{workspace="...",reason="..."} 42
 *
 * Gauge-on-snapshot rather than true counters (Render restarts
 * would otherwise reset the counter and break PromQL rate()). For
 * accurate rates over time customers should scrape these into
 * Prometheus / Grafana and use `irate()` on the gauge.
 *
 * Cardinality is bounded by the SQL — we GROUP BY high-cardinality
 * columns (workspace, reason, type) and emit no more than a few
 * thousand rows per scrape. Customers with large workspaces can
 * scrape less often.
 */

import type pg from "pg";
import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";
import type { QueueConsumerMetrics } from "./queue-consumer-metrics.js";

const SAFE_CIRCUIT_STATES = new Set([
  "closed",
  "disabled",
  "half_open",
  "open",
]);
const SAFE_QUEUE_FAILURE_CODES = new Set([
  "body_not_object",
  "invalid_base64",
  "invalid_field",
  "invalid_json",
  "missing_field",
  "unsupported_content_type",
  "unsupported_version",
]);

export interface MetricsSnapshot {
  text: string;
  generatedAt: string;
}

export async function renderMetrics(
  pool: pg.Pool,
  queueMetrics?: QueueConsumerMetrics,
): Promise<MetricsSnapshot> {
  const lines: string[] = [];
  const now = new Date().toISOString();

  // ---- destination circuit breakers ---- //
  lines.push(`# HELP axel_destinations_circuit_state Count of destinations by circuit state.`);
  lines.push(`# TYPE axel_destinations_circuit_state gauge`);
  try {
    const circuit = await pool.query<{ circuit_state: string; n: number }>(
      `SELECT circuit_state, count(*)::int AS n
         FROM destinations
        GROUP BY circuit_state`,
    );
    for (const [state, count] of aggregateMetricRows(
      circuit.rows,
      (row) => SAFE_CIRCUIT_STATES.has(row.circuit_state)
        ? row.circuit_state
        : "unknown",
    )) {
      lines.push(`axel_destinations_circuit_state{state="${labelValue(state)}"} ${count}`);
    }
  } catch {
    console.error("[metrics] circuit query failed");
  }

  // ---- delivery paused ---- //
  lines.push(`# HELP axel_destinations_delivery_paused Count of destinations with operator-paused delivery.`);
  lines.push(`# TYPE axel_destinations_delivery_paused gauge`);
  try {
    const paused = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM destinations WHERE delivery_paused`,
    );
    lines.push(`axel_destinations_delivery_paused ${paused.rows[0]?.n ?? 0}`);
  } catch {
    console.error("[metrics] paused query failed");
  }

  // ---- dead letters by reason (last 24h) ---- //
  lines.push(`# HELP axel_dead_letters_24h Dead letters in the last 24 hours, grouped by reason.`);
  lines.push(`# TYPE axel_dead_letters_24h gauge`);
  try {
    const dlq = await pool.query<{ reason: string; n: number }>(
      `SELECT reason, count(*)::int AS n
         FROM dead_letters
        WHERE errored_at > now() - interval '24 hours'
        GROUP BY reason
        ORDER BY n DESC
        LIMIT 50`,
    );
    for (const [reason, count] of aggregateMetricRows(
      dlq.rows,
      (row) => sanitizeConnectorDiagnosticForStorage(row.reason, 120),
    )) {
      lines.push(`axel_dead_letters_24h{reason="${labelValue(reason)}"} ${count}`);
    }
  } catch {
    console.error("[metrics] dlq query failed");
  }

  lines.push(`# HELP axel_queue_quarantine_24h Malformed queue messages seen in the last 24 hours, grouped by validation reason.`);
  lines.push(`# TYPE axel_queue_quarantine_24h gauge`);
  try {
    const quarantine = await pool.query<{ failure_code: string; n: number }>(
      `SELECT failure_code, count(*)::int AS n
         FROM queue_quarantine
        WHERE last_seen_at > now() - interval '24 hours'
        GROUP BY failure_code
        ORDER BY n DESC
        LIMIT 20`,
    );
    for (const [reason, count] of aggregateMetricRows(
      quarantine.rows,
      (row) => SAFE_QUEUE_FAILURE_CODES.has(row.failure_code)
        ? row.failure_code
        : "invalid_message",
    )) {
      lines.push(`axel_queue_quarantine_24h{reason="${labelValue(reason)}"} ${count}`);
    }
  } catch {
    // During a rolling deploy the service may start before migration 0070.
    // Runtime counters below still expose parser failures until the table lands.
    console.error("[metrics] queue quarantine query failed");
  }

  // ---- pull-sync runs in flight ---- //
  lines.push(`# HELP axel_pull_sync_runs_in_flight Count of pull sync runs currently running.`);
  lines.push(`# TYPE axel_pull_sync_runs_in_flight gauge`);
  try {
    const runs = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pull_sync_runs WHERE status = 'running'`,
    );
    lines.push(`axel_pull_sync_runs_in_flight ${runs.rows[0]?.n ?? 0}`);
  } catch {
    console.error("[metrics] pull runs query failed");
  }

  // ---- replay queue depth ---- //
  lines.push(`# HELP axel_replay_requests_pending Replay requests waiting for the worker.`);
  lines.push(`# TYPE axel_replay_requests_pending gauge`);
  try {
    const replays = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM replay_requests WHERE state = 'pending'`,
    );
    lines.push(`axel_replay_requests_pending ${replays.rows[0]?.n ?? 0}`);
  } catch {
    console.error("[metrics] replays query failed");
  }

  if (queueMetrics) lines.push(...queueMetrics.renderPrometheus());

  lines.push(`# Generated at ${now}`);
  return { text: lines.join("\n") + "\n", generatedAt: now };
}

function aggregateMetricRows<T extends { n: number }>(
  rows: readonly T[],
  codeFor: (row: T) => string,
): Array<[string, number]> {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const count = Number(row.n);
    if (!Number.isFinite(count) || count < 0) continue;
    const code = codeFor(row) || "operation_failed";
    totals.set(code, (totals.get(code) ?? 0) + count);
  }
  return [...totals].sort(([left], [right]) => left.localeCompare(right));
}

/**
 * Sanitise an SQL value for inclusion in a Prometheus label value.
 * The spec allows any UTF-8 except backslash, double-quote, newline,
 * which must be backslash-escaped.
 */
function labelValue(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  return String(raw)
    .replaceAll("\\", "\\\\")
    .replaceAll("\"", "\\\"")
    .replaceAll("\n", "\\n");
}
