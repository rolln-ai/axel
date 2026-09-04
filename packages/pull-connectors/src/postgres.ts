/**
 * Postgres pull connector (AXE-61).
 *
 * Each stream is either a `table` (auto-built keyset SELECT with the
 * cursor predicate) or a `query` (operator-provided SQL with `$1` for
 * the cursor parameter, `$2` for the page-size LIMIT). Pagination is
 * keyset on the cursor column — no OFFSET — so big tables don't melt.
 *
 * The connector itself doesn't depend on `pg`: callers pass a
 * `connect` factory that builds a `PgClient`. The pull-worker wires
 * a real `pg.Pool` factory; tests inject a fake. This keeps
 * @axel/pull-connectors dep-free and lets the dashboard's
 * test-connection action share the same client interface.
 */

import type {
  PullConnector,
  PullCursor,
  PullCursorType,
  PullPage,
  PullReadInput,
  PullRecord,
  PullSchemaObject,
  PullSource,
  PullStream,
  PullStreamConfig,
} from "./types";

export interface PostgresConfig {
  /** Full DSN (preferred). When set, host/port/etc are ignored. */
  connection_string?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: "require" | "prefer" | "disable" | "no-verify";
  /** Pagination cap per `read()` call. Default 500. */
  page_size?: number;
  streams?: PullStreamConfig[];
}

export type PostgresSource = PullSource<PostgresConfig>;

/**
 * Subset of `pg.Client` we depend on. Lets tests inject a fake
 * without pulling pg into this package.
 */
export interface PgClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

export interface PostgresConnect {
  (config: PostgresConfig): Promise<PgClient>;
}

const DEFAULT_PAGE_SIZE = 500;
// Hard cap so a runaway config can't ship a million-row page.
const MAX_PAGE_SIZE = 5000;

export function createPostgresConnector(deps: {
  connect: PostgresConnect;
}): PullConnector<PostgresConfig> {
  // Per-source client cache so we don't reconnect on every page.
  // Keyed by source_id; never evicted within a single runner pass.
  const clientCache = new Map<string, Promise<PgClient>>();

  function getClient(source: PostgresSource): Promise<PgClient> {
    const cached = clientCache.get(source.source_id);
    if (cached) return cached;
    const fresh = deps.connect(source.config);
    clientCache.set(source.source_id, fresh);
    return fresh;
  }

  return {
    type: "postgres",
    streams(config) {
      const declared = config.streams ?? [];
      return declared.map((stream) => new PostgresStream(stream, getClient));
    },
    // Drain the per-source client cache. Mirrors the Mongo connector's close():
    // the pull-worker rebuilds the connector registry every tick, so without
    // this each sync run leaks the cached pg.Pool — exhausting the source DB's
    // connection cap over time. Callers invoke this in a finally after the run
    // (both the worker poll loop and the dashboard "Sync now" path).
    async close() {
      const pending = [...clientCache.values()];
      clientCache.clear();
      await Promise.all(
        pending.map((p) =>
          p
            .then((c) => c.end())
            .catch(() => {
              // Swallow — a client that never connected (or already ended) is fine.
            }),
        ),
      );
    },
    async listSchemaObjects(config) {
      // Tied to a single source_id space so the cache stays consistent;
      // discovery is a one-shot, so we just open + close one connection.
      const client = await deps.connect(config);
      try {
        const tables = await client.query<{
          table_schema: string;
          table_name: string;
          table_type: string;
        }>(
          `SELECT table_schema, table_name, table_type
             FROM information_schema.tables
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name
            LIMIT $1`,
          [DISCOVERY_MAX_OBJECTS],
        );
        if (tables.rows.length === 0) return [];
        const cursorCols = await client.query<{
          table_schema: string;
          table_name: string;
          column_name: string;
        }>(
          `SELECT table_schema, table_name, column_name
             FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
              AND column_name = ANY($1)`,
          [CURSOR_CANDIDATE_COLUMN_NAMES],
        );
        const candidatesByTable = new Map<string, string[]>();
        for (const row of cursorCols.rows) {
          const key = `${row.table_schema}.${row.table_name}`;
          const list = candidatesByTable.get(key) ?? [];
          list.push(row.column_name);
          candidatesByTable.set(key, list);
        }
        return tables.rows.map((row): PullSchemaObject => {
          const qualified = `${row.table_schema}.${row.table_name}`;
          const candidates = candidatesByTable.get(qualified);
          return {
            name: qualified,
            kind: row.table_type === "VIEW" ? "view" : "table",
            parent: row.table_schema,
            ...(candidates && candidates.length > 0
              ? { cursor_candidates: candidates }
              : {}),
          };
        });
      } finally {
        try {
          await client.end();
        } catch {
          // Discovery is one-shot; swallow close errors.
        }
      }
    },
  };
}

const DISCOVERY_MAX_OBJECTS = 500;
const CURSOR_CANDIDATE_COLUMN_NAMES = ["updated_at", "created_at", "modified_at", "id"];

class PostgresStream implements PullStream<PostgresConfig> {
  readonly defaultCursorField: string;

  constructor(
    private readonly config: PullStreamConfig,
    private readonly getClient: (source: PostgresSource) => Promise<PgClient>,
  ) {
    this.defaultCursorField = config.cursor_column ?? "updated_at";
  }

  get name(): string {
    return this.config.name;
  }

  async read(input: PullReadInput<PostgresConfig>): Promise<PullPage> {
    const stream = input.stream;
    const cursorColumn = stream.cursor_column ?? this.defaultCursorField;
    const cursorType: PullCursorType = stream.cursor_type ?? "timestamp";
    const pageSize = clamp(
      input.source.config.page_size ?? DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
    );
    const primaryKey = stream.primary_key ?? "id";

    // Within a tick the runner re-calls read() with the prior page's nextCursor.
    // A composite keyset (cursor value + primary key) advances past every row
    // already seen, including rows that share the exact cursor value across a
    // page boundary — strict `>` on the cursor alone silently skipped those.
    // The page cursor carries both fields as JSON {c,pk}; the first read of a
    // tick (no pageCursor) resumes from the committed state cursor with no
    // tiebreak (the prior tick fully drained that value's ties).
    let cursorParam: unknown;
    let lastPk: unknown = null;
    if (input.pageCursor != null) {
      cursorParam = input.pageCursor;
      try {
        const parsed = JSON.parse(input.pageCursor) as unknown;
        if (parsed && typeof parsed === "object" && "c" in parsed) {
          cursorParam = (parsed as { c: unknown }).c;
          lastPk = (parsed as { pk?: unknown }).pk ?? null;
        }
      } catch {
        // Legacy plain-string page cursor from an in-flight pre-upgrade tick —
        // use it as the cursor value with no tiebreak.
      }
    } else {
      cursorParam = serialiseCursor(input.state?.cursor ?? null, cursorType);
    }

    const { sql, params } = buildSql({
      stream,
      cursorColumn,
      primaryKey,
      cursor: cursorParam,
      lastPk,
      pageSize,
    });

    const client = await this.getClient(input.source);
    const result = await client.query<Record<string, unknown>>(sql, params);

    let highWatermark = input.state?.cursor ?? null;
    const records: PullRecord[] = [];
    for (const row of result.rows) {
      const cursor = readCursor(row, cursorColumn, cursorType);
      highWatermark = maxCursor(highWatermark, cursor);
      const recordId = stringifyId(row[primaryKey]) ?? `${input.source.source_id}-${stream.name}-${records.length}`;
      records.push({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: "postgres",
        stream: stream.name,
        record_id: recordId,
        cursor,
        extracted_at: input.now().toISOString(),
        data: row,
      });
    }

    // A full page implies more rows may follow — hand the runner a nextCursor so
    // it fetches the next page this tick. Empty/short page → done (no nextCursor).
    // Encode the LAST row's (cursor, primary key) as the keyset position so the
    // next page resumes exactly after it without skipping cursor-tied rows.
    const page: PullPage = { records, highWatermark };
    if (records.length === pageSize && highWatermark != null) {
      const lastRow = result.rows[result.rows.length - 1]!;
      const lastCursor = readCursor(lastRow, cursorColumn, cursorType);
      page.nextCursor = JSON.stringify({
        c: serialiseCursor(lastCursor, cursorType),
        pk: lastRow[primaryKey] ?? null,
      });
    }
    return page;
  }
}

function buildSql(args: {
  stream: PullStreamConfig;
  cursorColumn: string;
  primaryKey: string;
  cursor: unknown;
  lastPk: unknown;
  pageSize: number;
}): { sql: string; params: unknown[] } {
  const { stream, cursorColumn, primaryKey, cursor, lastPk, pageSize } = args;
  if (stream.query) {
    // Operator-provided SQL must reference $1 (cursor) and $2 (limit). Custom
    // queries own their own ordering/tie handling, so the keyset tiebreak does
    // not apply — the contract is unchanged.
    const q = stream.query;
    if (!q.includes("$1")) {
      throw new PostgresStreamError(
        "missing_cursor_placeholder",
        `Custom SQL for stream "${stream.name}" must reference $1 (the cursor value).`,
      );
    }
    if (!q.includes("$2")) {
      throw new PostgresStreamError(
        "missing_limit_placeholder",
        `Custom SQL for stream "${stream.name}" must reference $2 (the page-size limit).`,
      );
    }
    return { sql: q, params: [cursor, pageSize] };
  }
  if (stream.table) {
    const table = sanitiseIdentifier(stream.table);
    const col = sanitiseIdentifier(cursorColumn);
    const pk = sanitiseIdentifier(primaryKey);
    if (lastPk != null) {
      // Composite keyset: advance past the cursor value, and WITHIN a tied
      // cursor value advance past the last primary key. This is what stops rows
      // sharing the boundary cursor value from being skipped across a page edge.
      // $1 cursor, $2 lastPk, $3 limit.
      return {
        sql: `SELECT * FROM ${table}
                WHERE ${col} > $1
                   OR (${col} = $1 AND ${pk} > $2)
                ORDER BY ${col} ASC, ${pk} ASC
                LIMIT $3`,
        params: [cursor, lastPk, pageSize],
      };
    }
    // First page of a tick: no prior primary key to tiebreak on. Order by
    // (cursor, pk) so pagination is deterministic and the keyset above lines up.
    return {
      sql: `SELECT * FROM ${table}
              WHERE ${col} > $1 OR $1 IS NULL
              ORDER BY ${col} ASC, ${pk} ASC
              LIMIT $2`,
      params: [cursor, pageSize],
    };
  }
  throw new PostgresStreamError(
    "missing_source",
    `Stream "${stream.name}" must declare either a table or a query.`,
  );
}

/**
 * Defence-in-depth identifier validation. The operator types these
 * (table + cursor column names) into the wizard, so we want to catch
 * SQL-injection attempts before they hit pg. PG identifiers can
 * legally include any character via `"..."` quoting; we restrict to
 * the safe subset that matches `[A-Za-z_][A-Za-z0-9_]*` plus an
 * optional `schema.` prefix. Rejected names throw — surfaces at
 * config time, not at sync time.
 */
function sanitiseIdentifier(name: string): string {
  const parts = name.split(".");
  if (parts.length > 2) {
    throw new PostgresStreamError("invalid_identifier", `"${name}" has too many dots.`);
  }
  for (const part of parts) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) {
      throw new PostgresStreamError(
        "invalid_identifier",
        `"${name}" must match [A-Za-z_][A-Za-z0-9_]*. Quote it via a custom query if you need special characters.`,
      );
    }
  }
  // Wrap each segment in double-quotes so we ship a fully-qualified
  // identifier that pg parses as case-sensitive (matching the user's
  // intent if they typed a mixed-case name).
  return parts.map((p) => `"${p}"`).join(".");
}

function serialiseCursor(cursor: PullCursor | null, type: PullCursorType): unknown {
  if (cursor === null) return null;
  const v = cursor.value;
  if (v === null) return null;
  if (type === "integer") return typeof v === "number" ? v : Number(v);
  if (type === "string") return String(v);
  if (type === "timestamp") return typeof v === "number" ? new Date(v).toISOString() : String(v);
  // objectid is Mongo-only; the Postgres connector accepts the value
  // as-is in case the operator's storing them as text.
  return v;
}

function readCursor(
  row: Record<string, unknown>,
  column: string,
  type: PullCursorType,
): PullCursor | null {
  const v = row[column];
  if (v === null || v === undefined) return null;
  if (type === "integer") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? { value: n } : null;
  }
  if (type === "timestamp") {
    if (v instanceof Date) return { value: v.toISOString() };
    return { value: String(v) };
  }
  return { value: typeof v === "string" || typeof v === "number" ? v : String(v) };
}

function maxCursor(a: PullCursor | null, b: PullCursor | null): PullCursor | null {
  if (a === null) return b;
  if (b === null) return a;
  if (a.value === null) return b;
  if (b.value === null) return a;
  // String comparison is correct for ISO timestamps + lexicographic
  // ids; numbers compare numerically because of the `>` coercion.
  return (b.value as never) > (a.value as never) ? b : a;
}

function stringifyId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return null;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export class PostgresStreamError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
    this.name = "PostgresStreamError";
  }
}

/**
 * Standalone "ping the database" check used by the dashboard's
 * test-connection action. Doesn't need a connector — just a working
 * `connect` factory + a config.
 */
export async function testPostgresConnection(
  config: PostgresConfig,
  deps: { connect: PostgresConnect },
): Promise<{ ok: true; latency_ms: number } | { ok: false; reason: string; message: string }> {
  let client: PgClient | null = null;
  const started = Date.now();
  try {
    client = await deps.connect(config);
    await client.query("SELECT 1");
    return { ok: true, latency_ms: Date.now() - started };
  } catch {
    return {
      ok: false,
      reason: "connection_failed",
      message: "connection_failed",
    };
  } finally {
    if (client) {
      try {
        await client.end();
      } catch {
        // Swallow close errors — the test result is what matters.
      }
    }
  }
}
