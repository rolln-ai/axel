/**
 * Shared ClickHouse HTTP insert helper.
 *
 * Every runtime that logs analytics rows (ingest-worker and pull-worker →
 * `events`, delivery-edge and delivery-service → `delivery_attempts`) used to
 * carry its own copy of the same URL/header/error-handling block, and the
 * copies had drifted. This is the single implementation; each app keeps only
 * its row builder.
 *
 * Semantics (identical to the previous per-app copies):
 *   - No-op when `CLICKHOUSE_URL` is unset — analytics views just go empty.
 *   - `async_insert=1` batches small inserts server-side;
 *     `wait_for_async_insert=0` so we don't block on the flush (a synchronous
 *     wait serialized under load and dropped rows when overwhelmed);
 *     `async_insert_busy_timeout_ms=1000` bounds the buffer/durability window.
 *   - Fire-and-forget: failures are logged and swallowed — we'd rather miss an
 *     analytics row than crash a worker on a transient ClickHouse outage.
 */

export interface ClickhouseInsertEnv {
  CLICKHOUSE_URL?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_PASSWORD?: string;
}

export interface ClickhouseInsertOptions {
  /**
   * Set `input_format_skip_unknown_fields=1` so a row field the table doesn't
   * (yet) have is skipped instead of failing the whole insert. Used by the
   * `events` writers to tolerate deploy ordering around new columns.
   */
  skipUnknownFields?: boolean;
}

/**
 * Format an ISO 8601 timestamp for a ClickHouse DateTime64(3) column via
 * JSONEachRow: `YYYY-MM-DD HH:MM:SS.fff` (space separator, no trailing Z —
 * ClickHouse treats values as UTC by default).
 */
export function toClickhouseDateTime(iso: string): string {
  return iso.replace("T", " ").replace(/Z$/, "");
}

export async function insertRows(
  env: ClickhouseInsertEnv,
  table: string,
  rows: Record<string, unknown>[],
  options: ClickhouseInsertOptions = {},
): Promise<void> {
  if (!env.CLICKHOUSE_URL || rows.length === 0) return;

  const url = new URL(env.CLICKHOUSE_URL);
  // Use a query-string `query=` param so the body is just the row JSON.
  url.searchParams.set("query", `INSERT INTO ${table} FORMAT JSONEachRow`);
  url.searchParams.set("async_insert", "1");
  url.searchParams.set("wait_for_async_insert", "0");
  url.searchParams.set("async_insert_busy_timeout_ms", "1000");
  if (options.skipUnknownFields) {
    url.searchParams.set("input_format_skip_unknown_fields", "1");
  }

  const headers: Record<string, string> = {
    "content-type": "application/x-ndjson",
  };
  if (env.CLICKHOUSE_USER) headers["x-clickhouse-user"] = env.CLICKHOUSE_USER;
  if (env.CLICKHOUSE_PASSWORD) headers["x-clickhouse-key"] = env.CLICKHOUSE_PASSWORD;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: rows.map((row) => JSON.stringify(row)).join("\n"),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[clickhouse] ${table} insert ${res.status}: ${body.slice(0, 200)}`);
    }
  } catch (err) {
    console.error(`[clickhouse] ${table} insert failed:`, err);
  }
}
