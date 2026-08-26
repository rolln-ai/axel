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

export interface MetricsSnapshot {
  text: string;
  generatedAt: string;
}

export async function renderMetrics(pool: pg.Pool): Promise<MetricsSnapshot> {
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
    for (const row of circuit.rows) {
      lines.push(`axel_destinations_circuit_state{state="${labelValue(row.circuit_state)}"} ${row.n}`);
    }
  } catch (err) {
    console.error("[metrics] circuit query failed", err);
  }

  // ---- delivery paused ---- //
  lines.push(`# HELP axel_destinations_delivery_paused Count of destinations with operator-paused delivery.`);
  lines.push(`# TYPE axel_destinations_delivery_paused gauge`);
  try {
    const paused = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM destinations WHERE delivery_paused`,
    );
    lines.push(`axel_destinations_delivery_paused ${paused.rows[0]?.n ?? 0}`);
  } catch (err) {
    console.error("[metrics] paused query failed", err);
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
    for (const row of dlq.rows) {
      lines.push(`axel_dead_letters_24h{reason="${labelValue(row.reason)}"} ${row.n}`);
    }
  } catch (err) {
    console.error("[metrics] dlq query failed", err);
  }

  // ---- pull-sync runs in flight ---- //
  lines.push(`# HELP axel_pull_sync_runs_in_flight Count of pull sync runs currently running.`);
  lines.push(`# TYPE axel_pull_sync_runs_in_flight gauge`);
  try {
    const runs = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pull_sync_runs WHERE status = 'running'`,
    );
    lines.push(`axel_pull_sync_runs_in_flight ${runs.rows[0]?.n ?? 0}`);
  } catch (err) {
    console.error("[metrics] pull runs query failed", err);
  }

  // ---- replay queue depth ---- //
  lines.push(`# HELP axel_replay_requests_pending Replay requests waiting for the worker.`);
  lines.push(`# TYPE axel_replay_requests_pending gauge`);
  try {
    const replays = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM replay_requests WHERE state = 'pending'`,
    );
    lines.push(`axel_replay_requests_pending ${replays.rows[0]?.n ?? 0}`);
  } catch (err) {
    console.error("[metrics] replays query failed", err);
  }

  lines.push(`# Generated at ${now}`);
  return { text: lines.join("\n") + "\n", generatedAt: now };
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
