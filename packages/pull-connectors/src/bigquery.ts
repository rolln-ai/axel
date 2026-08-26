/**
 * BigQuery pull connector (AXE-63).
 *
 * Each stream is either a `{dataset, table}` pair (auto-built
 * incremental SELECT) or a custom SQL query with a `@cursor` named
 * parameter. BigQuery's standard query API streams pages back via
 * `nextPageToken`; the connector exposes `pageCursor` so the runner
 * can ask for the next page until the page-size cap or the stream
 * is exhausted.
 *
 * The connector itself is driver-free — callers pass a `query`
 * factory. The pull-worker wires the official `@google-cloud/bigquery`
 * client; tests inject a fake. Same shape as the AXE-61 Postgres and
 * AXE-62 Mongo connectors.
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

export interface BigQueryConfig {
  /** GCP project the queries run in. Required. */
  project_id: string;
  /** Region (e.g. "US", "EU"). Optional. */
  location?: string;
  /** Pagination cap per `read()` call. Default 500. */
  page_size?: number;
  streams?: PullStreamConfig[];
}

export interface BigQueryCredentials {
  /** Service account JSON, paste-shaped. Stored encrypted. */
  service_account_json: string;
}

export type BigQuerySource = PullSource<BigQueryConfig & Partial<BigQueryCredentials>>;

/**
 * The thin query interface the connector relies on. Lets tests inject
 * a fake without dragging the @google-cloud/bigquery SDK in.
 */
export interface BigQueryClientLike {
  query(input: {
    sql: string;
    params: Record<string, unknown>;
    location?: string;
    pageToken?: string;
    maxResults: number;
  }): Promise<{ rows: Record<string, unknown>[]; nextPageToken?: string }>;
}

export interface BigQueryConnect {
  (config: BigQueryConfig & Partial<BigQueryCredentials>): Promise<BigQueryClientLike>;
}

const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 5000;

export function createBigQueryConnector(deps: {
  connect: BigQueryConnect;
}): PullConnector<BigQueryConfig & Partial<BigQueryCredentials>> {
  // Per-source client cache.
  const clientCache = new Map<string, Promise<BigQueryClientLike>>();

  function getClient(source: BigQuerySource): Promise<BigQueryClientLike> {
    const cached = clientCache.get(source.source_id);
    if (cached) return cached;
    const fresh = deps.connect(source.config);
    clientCache.set(source.source_id, fresh);
    return fresh;
  }

  return {
    type: "bigquery",
    streams(config) {
      const declared = config.streams ?? [];
      return declared.map((stream) => new BigQueryStream(stream, getClient));
    },
    async listSchemaObjects(config) {
      // Single-shot client — discovery is one query into the
      // region-specific INFORMATION_SCHEMA, plus a JOIN to surface
      // cursor candidates inline. project_id is implicit because the
      // BigQuery client is constructed with it.
      const client = await deps.connect(config);
      // BigQuery's region-qualified INFORMATION_SCHEMA needs the `region-`
      // prefix: `region-us`, `region-eu`, `region-us-central1`. A configured
      // location like "US" / "us-central1" lacks it, so discovery failed for
      // every workspace that set a location. Add it (idempotently).
      const loc = (config.location ?? "us").toLowerCase();
      const region = loc.startsWith("region-") ? loc : `region-${loc}`;
      // INFORMATION_SCHEMA.SCHEMATA -> the dataset list. Then for each
      // dataset INFORMATION_SCHEMA.TABLES + COLUMNS gives us tables +
      // cursor candidates.
      const sql = `
        WITH base AS (
          SELECT
            t.table_schema AS dataset,
            t.table_name,
            t.table_type
          FROM \`${region}\`.INFORMATION_SCHEMA.TABLES_BY_PROJECT t
          WHERE t.table_type IN ('BASE TABLE', 'VIEW')
          LIMIT @limit
        ),
        cursors AS (
          SELECT
            c.table_schema AS dataset,
            c.table_name,
            ARRAY_AGG(c.column_name) AS cursor_cols
          FROM \`${region}\`.INFORMATION_SCHEMA.COLUMNS_BY_PROJECT c
          WHERE LOWER(c.column_name) IN ('updated_at', 'created_at', 'modified_at', 'id')
             OR ENDS_WITH(LOWER(c.column_name), '_at')
             OR ENDS_WITH(LOWER(c.column_name), '_time')
          GROUP BY c.table_schema, c.table_name
        )
        SELECT b.dataset, b.table_name, b.table_type, c.cursor_cols
          FROM base b
          LEFT JOIN cursors c USING (dataset, table_name)
      `;
      const result = await client.query({
        sql,
        params: { limit: BIGQUERY_DISCOVERY_MAX },
        ...(config.location ? { location: config.location } : {}),
        maxResults: BIGQUERY_DISCOVERY_MAX,
      });
      return result.rows.map((row): PullSchemaObject => {
        const dataset = String(row.dataset ?? "");
        const tableName = String(row.table_name ?? "");
        const cursorCols = Array.isArray(row.cursor_cols)
          ? (row.cursor_cols as unknown[]).filter((v): v is string => typeof v === "string")
          : undefined;
        return {
          name: `${dataset}.${tableName}`,
          kind: row.table_type === "VIEW" ? "view" : "table",
          parent: dataset,
          ...(cursorCols && cursorCols.length > 0 ? { cursor_candidates: cursorCols } : {}),
        };
      });
    },
  };
}

const BIGQUERY_DISCOVERY_MAX = 500;

class BigQueryStream implements PullStream<BigQueryConfig & Partial<BigQueryCredentials>> {
  readonly defaultCursorField: string;

  constructor(
    private readonly config: PullStreamConfig,
    private readonly getClient: (source: BigQuerySource) => Promise<BigQueryClientLike>,
  ) {
    this.defaultCursorField = config.cursor_column ?? "updated_at";
  }

  get name(): string {
    return this.config.name;
  }

  async read(input: PullReadInput<BigQueryConfig & Partial<BigQueryCredentials>>): Promise<PullPage> {
    const stream = input.stream;
    const cursorColumn = stream.cursor_column ?? this.defaultCursorField;
    const cursorType: PullCursorType = stream.cursor_type ?? "timestamp";
    const pageSize = clamp(
      input.source.config.page_size ?? DEFAULT_PAGE_SIZE,
      1,
      MAX_PAGE_SIZE,
    );
    const primaryKey = stream.primary_key ?? "id";
    const lastCursor = input.state?.cursor ?? null;
    let cursorValue = serialiseCursor(lastCursor, cursorType);

    const sql = buildSql({ stream, cursorColumn, pageSize });

    // Custom-SQL null-cursor consistency (audit). The auto path null-guards via
    // `... OR @cursor IS NULL`, so its first run returns every row. The custom
    // path can't rewrite the operator's predicate, and a typical `col > @cursor`
    // evaluates to NULL (→ no match) when @cursor IS NULL — so the first run
    // returned ZERO rows and, with no high-watermark, never advanced (the stream
    // stalled forever). Substitute a typed minimum sentinel for the null cursor
    // so `col > @cursor` / `col >= @cursor` matches all rows on the first run,
    // matching the auto path. Subsequent runs use the real watermark.
    if (stream.sql && cursorValue === null) {
      cursorValue = minSentinelForCursorType(cursorType);
    }

    const client = await this.getClient(input.source);
    const result = await client.query({
      sql,
      params: { cursor: cursorValue },
      ...(input.source.config.location ? { location: input.source.config.location } : {}),
      ...(input.pageCursor ? { pageToken: input.pageCursor } : {}),
      maxResults: pageSize,
    });

    let highWatermark = lastCursor;
    const records: PullRecord[] = [];
    for (const row of result.rows) {
      const cursor = readCursor(row, cursorColumn, cursorType);
      highWatermark = maxCursor(highWatermark, cursor);
      const recordId = stringifyId(row[primaryKey]) ?? `${input.source.source_id}-${stream.name}-${records.length}`;
      records.push({
        source_id: input.source.source_id,
        workspace_id: input.source.workspace_id,
        source_type: "bigquery",
        stream: stream.name,
        record_id: recordId,
        cursor,
        extracted_at: input.now().toISOString(),
        data: row,
      });
    }

    const page: PullPage = { records, highWatermark };
    if (result.nextPageToken) page.nextCursor = result.nextPageToken;
    return page;
  }
}

function buildSql(args: {
  stream: PullStreamConfig;
  cursorColumn: string;
  pageSize: number;
}): string {
  const { stream, cursorColumn, pageSize } = args;
  if (stream.sql) {
    if (!stream.sql.includes("@cursor")) {
      throw new BigQueryStreamError(
        "missing_cursor_param",
        `Custom SQL for stream "${stream.name}" must reference the @cursor named parameter.`,
      );
    }
    // Bound the custom query so the BigQuery client can't auto-paginate an
    // unbounded result set into memory and OOM the pull-worker (audit). Wrap +
    // LIMIT; the @cursor still advances each tick, so it remains incremental.
    return `SELECT * FROM (${stream.sql}) AS axel_custom LIMIT ${pageSize}`;
  }
  if (stream.dataset && stream.table) {
    const dataset = sanitiseIdentifier(stream.dataset, true);
    const table = sanitiseIdentifier(stream.table, true);
    const col = sanitiseIdentifier(cursorColumn);
    // BigQuery: backtick-quoted dataset.table; @cursor named parameter
    // (see google-cloud/bigquery params docs); LIMIT inline since the
    // standard query API takes the maxResults via the request envelope
    // — but we hard-bound here too as defence in depth against custom
    // SQL paths that bypass maxResults.
    // Inclusive (>=) watermark, NOT strict (>): a strict cursor silently drops
    // every row that shares the page-boundary max cursor value but didn't fit on
    // the page (audit: tie-break records lost). The boundary rows are re-fetched
    // each pull, but the pull event_id is deterministic per (record_id, cursor),
    // so they dedup at delivery instead of duplicating.
    return `SELECT *
              FROM \`${dataset}.${table}\`
              WHERE ${col} >= @cursor OR @cursor IS NULL
              ORDER BY ${col} ASC
              LIMIT ${pageSize}`;
  }
  throw new BigQueryStreamError(
    "missing_source",
    `Stream "${stream.name}" must declare either {dataset, table} or sql.`,
  );
}

function sanitiseIdentifier(name: string, allowHyphen = false): string {
  // dataset/table names are backtick-quoted in the query, so a hyphen — valid
  // in GCP project-qualified names and rejected before, breaking common
  // datasets (audit) — is safe there. The cursor column is interpolated
  // UNQUOTED, so it stays strict. A backtick is never allowed in either, so
  // there is no quote break-out.
  const re = allowHyphen ? /^[A-Za-z_][A-Za-z0-9_-]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!re.test(name)) {
    throw new BigQueryStreamError(
      "invalid_identifier",
      `"${name}" must match ${allowHyphen ? "[A-Za-z_][A-Za-z0-9_-]*" : "[A-Za-z_][A-Za-z0-9_]*"}. Use a custom sql stream for special characters.`,
    );
  }
  return name;
}

function serialiseCursor(cursor: PullCursor | null, type: PullCursorType): unknown {
  if (cursor === null || cursor.value === null) return null;
  const v = cursor.value;
  if (type === "integer") return typeof v === "number" ? v : Number(v);
  if (type === "string") return String(v);
  if (type === "timestamp") return typeof v === "number" ? new Date(v).toISOString() : String(v);
  return v;
}

/**
 * A typed minimum cursor sentinel for the custom-SQL first run. Chosen so that
 * `col > @cursor` (or `>=`) admits every row: the epoch for timestamps, a
 * sentinel below any plausible id for integers, the empty string for strings.
 * Only used when the persisted cursor is null (first sync) on the custom path —
 * the auto path null-guards in SQL instead.
 */
function minSentinelForCursorType(type: PullCursorType): unknown {
  if (type === "integer") return Number.MIN_SAFE_INTEGER;
  if (type === "string") return "";
  // timestamp (default) — the BigQuery TIMESTAMP epoch floor.
  return "0001-01-01T00:00:00.000Z";
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

export class BigQueryStreamError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.reason = reason;
    this.name = "BigQueryStreamError";
  }
}

/**
 * Standalone "ping the project" check used by the dashboard's
 * test-connection action — runs `SELECT 1` so we exercise the auth
 * + the project + the location settings end-to-end.
 */
export async function testBigQueryConnection(
  config: BigQueryConfig & Partial<BigQueryCredentials>,
  deps: { connect: BigQueryConnect },
): Promise<{ ok: true; latency_ms: number } | { ok: false; reason: string; message: string }> {
  const started = Date.now();
  try {
    const client = await deps.connect(config);
    await client.query({
      sql: "SELECT 1 AS ping",
      params: {},
      ...(config.location ? { location: config.location } : {}),
      maxResults: 1,
    });
    return { ok: true, latency_ms: Date.now() - started };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: "connection_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
