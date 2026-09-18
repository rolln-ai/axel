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
 *   - Transient failures (a transport error, 429, or 5xx) are retried twice
 *     with a short backoff before giving up. A lost `delivery_attempts` row
 *     makes a delivered event look undelivered to incident monitoring, so a
 *     one-second blip should not cost the row. A retry after an ambiguous
 *     transport failure can duplicate a row; every reader collapses rows by
 *     id (uniqExact, DISTINCT, ReplacingMergeTree), so duplicates are harmless.
 */

const INSERT_ATTEMPTS = 3;
const INSERT_RETRY_BASE_MS = 200;

function transientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

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
  const body = rows.map((row) => JSON.stringify(row)).join("\n");

  for (let attempt = 1; attempt <= INSERT_ATTEMPTS; attempt += 1) {
    let status = 0;
    let transient = true;
    try {
      const res = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers,
        body,
      });
      if (res.ok) return;
      status = res.status;
      transient = transientStatus(res.status);
      // Release the connection. The body may echo the submitted row, so it is
      // never read or logged.
      try {
        await res.body?.cancel();
      } catch {
        // Nothing to release.
      }
    } catch {
      // Transport failure: the request may or may not have reached ClickHouse.
    }
    if (transient && attempt < INSERT_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, INSERT_RETRY_BASE_MS * attempt));
      continue;
    }
    // ClickHouse parse errors can echo the submitted JSON row. That row can
    // include webhook metadata or a destination response excerpt, so status
    // is the only safe process-log diagnostic. Fetch exceptions may attach the
    // request, so they are never logged either.
    const outcome = status ? `insert ${status}` : "insert transport failed";
    const retries = attempt > 1 ? ` after ${attempt} attempts` : "";
    console.error(`[clickhouse] ${table} ${outcome}${retries}`);
    return;
  }
}
