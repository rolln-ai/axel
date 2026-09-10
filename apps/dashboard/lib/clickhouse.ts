import "server-only";
import { isTransientFetchError, isTransientPlatformHttpError } from "@axel/observability";

export interface ClickhouseQueryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, string | number>,
  ): Promise<{ rows: T[] }>;
}

/** Keep machine-readable failures without retaining SQL or provider response bodies. */
export class ClickhouseQueryError extends Error {
  constructor(readonly status: number, readonly code: number | null) {
    super(`ClickHouse query failed (${status})`);
    this.name = "ClickhouseQueryError";
  }
}

function exceptionCode(response: Response): number | null {
  const raw = response.headers.get("x-clickhouse-exception-code");
  // Never retain arbitrary header text in errors or telemetry.
  return raw && /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null;
}

export function hasClickhouseUrl(): boolean {
  return Boolean(process.env.CLICKHOUSE_URL);
}

declare global {
  // eslint-disable-next-line no-var
  var __axelClickhouseFetch: typeof fetch | undefined;
}

const CLICKHOUSE_QUERY_ATTEMPTS = 3;
const CLICKHOUSE_QUERY_RETRY_BASE_DELAY_MS = 250;
const DEFAULT_CLICKHOUSE_QUERY_MEMORY_BYTES = 512 * 1024 * 1024;
const DEFAULT_CLICKHOUSE_MAX_THREADS = 2;
const DEFAULT_CLICKHOUSE_MAX_RESULT_ROWS = 10_000;

/**
 * Tiny ClickHouse HTTP client.
 *
 * - Uses the JSON output format and parameterised queries (`{name:Type}`),
 *   so we never concatenate untrusted strings into SQL.
 * - Accepts `CLICKHOUSE_URL`, `CLICKHOUSE_USER`, `CLICKHOUSE_PASSWORD`.
 * - Designed for read-only analytical queries from server components.
 *
 * `options.unbounded` drops the `max_result_rows`/`result_overflow_mode=break`
 * cap. The cap protects the dashboard/analytics UI from a runaway result set,
 * but `break` SILENTLY truncates — fine for a paginated view, catastrophic for
 * a billing aggregate (GROUP BY workspace_id past the cap is never metered or
 * billed). Billing/metering callers pass `{ unbounded: true }`; UI callers must
 * not.
 */
export function clickhouse(options?: {
  unbounded?: boolean;
  /** Override the interactive-query timeout for bounded background work. */
  timeoutMs?: number;
  /** Retry client-side timeout aborts. Keep disabled for latency-sensitive UI reads. */
  retryTimeouts?: boolean;
  /** Spill monitoring joins to disk instead of building an unbounded hash table. */
  mergeJoins?: boolean;
}): ClickhouseQueryable {
  const baseUrl = process.env.CLICKHOUSE_URL;
  if (!baseUrl) {
    throw new Error("CLICKHOUSE_URL is required for usage analytics queries.");
  }
  const user = process.env.CLICKHOUSE_USER ?? "default";
  const password = process.env.CLICKHOUSE_PASSWORD ?? "";
  const queryTimeoutMs = options?.timeoutMs
    ?? Number.parseInt(process.env.CLICKHOUSE_QUERY_TIMEOUT_MS ?? "8000", 10);
  const queryMemoryBytes = Number.parseInt(
    process.env.CLICKHOUSE_QUERY_MAX_MEMORY_BYTES ?? String(DEFAULT_CLICKHOUSE_QUERY_MEMORY_BYTES),
    10,
  );
  const maxThreads = Number.parseInt(process.env.CLICKHOUSE_QUERY_MAX_THREADS ?? String(DEFAULT_CLICKHOUSE_MAX_THREADS), 10);
  const maxResultRows = Number.parseInt(
    process.env.CLICKHOUSE_QUERY_MAX_RESULT_ROWS ?? String(DEFAULT_CLICKHOUSE_MAX_RESULT_ROWS),
    10,
  );

  return {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: Record<string, string | number> = {},
    ): Promise<{ rows: T[] }> {
      const url = new URL(baseUrl);
      url.searchParams.set("default_format", "JSON");
      if (Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0) {
        url.searchParams.set("max_execution_time", String(Math.ceil(queryTimeoutMs / 1000)));
      }
      if (Number.isFinite(queryMemoryBytes) && queryMemoryBytes > 0) {
        url.searchParams.set("max_memory_usage", String(queryMemoryBytes));
        url.searchParams.set("max_bytes_before_external_group_by", String(Math.floor(queryMemoryBytes / 4)));
        url.searchParams.set("max_bytes_before_external_sort", String(Math.floor(queryMemoryBytes / 4)));
      }
      if (Number.isFinite(maxThreads) && maxThreads > 0) {
        url.searchParams.set("max_threads", String(maxThreads));
      }
      if (options?.mergeJoins) url.searchParams.set("join_algorithm", "full_sorting_merge");
      if (!options?.unbounded && Number.isFinite(maxResultRows) && maxResultRows > 0) {
        url.searchParams.set("max_result_rows", String(maxResultRows));
        url.searchParams.set("result_overflow_mode", "break");
      }
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(`param_${key}`, String(value));
      }

      const fetchImpl = globalThis.__axelClickhouseFetch ?? fetch;
      for (let attempt = 1; attempt <= CLICKHOUSE_QUERY_ATTEMPTS; attempt += 1) {
        const controller =
          Number.isFinite(queryTimeoutMs) && queryTimeoutMs > 0
            ? new AbortController()
            : null;
        const timeout =
          controller
            ? setTimeout(() => controller.abort(), queryTimeoutMs)
            : null;
        try {
          const res = await fetchImpl(url, {
            method: "POST",
            redirect: "manual",
            body: sql,
            signal: controller?.signal,
            headers: {
              "Content-Type": "text/plain; charset=UTF-8",
              "X-ClickHouse-User": user,
              ...(password ? { "X-ClickHouse-Key": password } : {}),
            },
          });

          const code = exceptionCode(res);
          if (!res.ok || code !== null) {
            await res.body?.cancel().catch(() => undefined);
            const error = new ClickhouseQueryError(res.status, code);
            if (attempt < CLICKHOUSE_QUERY_ATTEMPTS && isTransientPlatformHttpError(error)) {
              await sleep(CLICKHOUSE_QUERY_RETRY_BASE_DELAY_MS * attempt);
              continue;
            }
            throw error;
          }

          const text = await res.text();
          if (!text.trim()) return { rows: [] };

          let json: { data?: T[] };
          try {
            json = JSON.parse(text) as { data?: T[] };
          } catch {
            throw new Error("ClickHouse returned invalid JSON");
          }
          return { rows: json.data ?? [] };
        } catch (err) {
          if (controller?.signal.aborted) {
            if (options?.retryTimeouts && attempt < CLICKHOUSE_QUERY_ATTEMPTS) {
              await sleep(CLICKHOUSE_QUERY_RETRY_BASE_DELAY_MS * attempt);
              continue;
            }
            throw new Error(`ClickHouse query timed out after ${queryTimeoutMs}ms`);
          }
          if (attempt < CLICKHOUSE_QUERY_ATTEMPTS && (isTransientFetchError(err) || isTransientPlatformHttpError(err))) {
            await sleep(CLICKHOUSE_QUERY_RETRY_BASE_DELAY_MS * attempt);
            continue;
          }
          throw err;
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }

      throw new Error("ClickHouse query failed after retries");
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
