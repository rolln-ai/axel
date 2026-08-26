export type PullSourceType =
  | "chargebee"
  | "stripe"
  | "shopify"
  | "postgres"
  | "mongodb"
  | "bigquery";

export type PullSyncMode = "incremental" | "full_refresh";

/**
 * Cursor type drives both how the connector serialises the cursor
 * value into its query and how state is round-tripped through the
 * `pull_sync_runs` rows. DB pulls add `objectid` (Mongo) on top of
 * the original SaaS-API set.
 */
export type PullCursorType = "timestamp" | "integer" | "string" | "objectid";

export interface PullSource<TConfig = unknown> {
  source_id: string;
  workspace_id: string;
  type: PullSourceType;
  name: string;
  config: TConfig;
  credentials_ref?: string | null;
}

export interface PullStreamConfig {
  name: string;
  sync_mode?: PullSyncMode;
  cursor_field?: string;
  selected?: boolean;
  /**
   * AXE-60 — DB-pull stream shape. SaaS API streams ignore these:
   * each Stripe/Shopify/Chargebee stream is a fixed entity. DB
   * streams need either a `table` (auto-built SELECT/find with the
   * cursor predicate) or a `query`/`pipeline`/`sql` (operator-
   * provided, must reference the cursor parameter).
   */
  table?: string;
  /** Postgres custom SQL with `$1` cursor placeholder. */
  query?: string;
  /** Mongo collection name (paired with optional `pipeline`). */
  collection?: string;
  /** Mongo aggregation pipeline (JSON-stringified). Must contain a
   *  `$match` stage with `cursor_column` `$gt` placeholder. */
  pipeline?: string;
  /** BigQuery dataset (paired with `table`). */
  dataset?: string;
  /** BigQuery custom SQL with `@cursor` parameter. */
  sql?: string;
  /** Column to track high-watermark on. Required for DB streams. */
  cursor_column?: string;
  /** How to serialise the cursor value into the underlying query. */
  cursor_type?: PullCursorType;
  /** Column whose value becomes `PullRecord.record_id` (used for
   *  downstream dedupe). Defaults to `id` / `_id`. */
  primary_key?: string;
}

export interface PullCursor {
  value: string | number | null;
}

export interface PullStreamState {
  cursor: PullCursor | null;
  /**
   * Within-pageset resume token (the connector's `nextCursor` / `starting_after`
   * equivalent), persisted per page so a mid-stream crash resumes pagination from
   * the interrupted page instead of restarting. Restarting is silently lossy for
   * DESCENDING streams (e.g. Stripe lists are newest-first): once the committed
   * `cursor` advanced to page 1's global-max value, the next run's `> cursor`
   * filter skips every older, never-fetched page. Null/absent = no pageset in
   * flight (clean incremental boundary). Optional for backward compatibility with
   * rows written before this field existed.
   */
  resumePageCursor?: string | null;
  /**
   * Highest record cursor observed across the in-flight pageset. The committed
   * cursor must stay pinned while `resumePageCursor` is present (otherwise a
   * newest-first API skips unread older pages), so this separate value carries
   * the eventual commit point across capped runs and process restarts.
   */
  pendingHighWatermark?: PullCursor | null;
  updated_at: string;
}

export interface PullSourceState {
  streams: Record<string, PullStreamState>;
}

export interface PullRecord {
  source_id: string;
  workspace_id: string;
  source_type: PullSourceType;
  stream: string;
  record_id: string;
  cursor: PullCursor | null;
  extracted_at: string;
  data: unknown;
}

export interface PullPage {
  records: PullRecord[];
  nextCursor?: string;
  highWatermark: PullCursor | null;
}

export interface PullStream<TConfig = unknown> {
  name: string;
  defaultCursorField: string;
  read(input: PullReadInput<TConfig>): Promise<PullPage>;
}

export interface PullReadInput<TConfig = unknown> {
  source: PullSource<TConfig>;
  stream: PullStreamConfig;
  state: PullStreamState | null;
  pageCursor?: string;
  now: () => Date;
  signal?: AbortSignal;
}

export interface PullConnector<TConfig = unknown> {
  type: PullSourceType;
  streams(config: TConfig): PullStream<TConfig>[];
  /**
   * AXE-64 — optional schema discovery. DB pulls implement it to list
   * tables / collections / datasets so the wizard can offer a picker
   * instead of free-form typing. SaaS pulls (Stripe, Shopify, etc.)
   * have a fixed entity set and skip this method.
   */
  listSchemaObjects?(config: TConfig): Promise<PullSchemaObject[]>;
  /**
   * Release any pooled connections/clients the connector cached during a sync
   * run. The pull-worker rebuilds the registry per tick, so a connector that
   * caches a client (e.g. mongodb) MUST implement this or it leaks the pool every
   * tick. The caller invokes it in a finally after the run; SaaS HTTP connectors
   * hold nothing and can omit it.
   */
  close?(): Promise<void>;
}

export interface PullSchemaObject {
  /** Display + selection identifier. For Postgres/BigQuery this is
   *  the qualified name (`schema.table` or `dataset.table`); for
   *  Mongo it's the collection name. */
  name: string;
  kind: "table" | "view" | "collection" | "dataset";
  /** Optional grouping hint — Postgres schema, BigQuery dataset.
   *  Lets the wizard render the picker grouped by parent. */
  parent?: string;
  /** Columns / fields the connector judges plausible cursor candidates
   *  (timestamp-shaped or monotonic id-shaped). The wizard surfaces
   *  these as a dropdown next to each picked stream. */
  cursor_candidates?: string[];
  /** Approximate row/document count when cheap to fetch. Optional —
   *  not all backends expose this without a full COUNT(*). */
  approx_rows?: number;
}

export interface PullStateStore {
  get(sourceId: string): Promise<PullSourceState | null>;
  setStreamState(sourceId: string, streamName: string, state: PullStreamState): Promise<void>;
}

export interface PullRecordSink {
  write(record: PullRecord): Promise<void>;
}

export interface PullRunOptions {
  streams?: string[];
  maxPagesPerStream?: number;
  maxRecordsPerStream?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface PullStreamSummary {
  stream: string;
  records: number;
  pages: number;
  cursor: PullCursor | null;
  status: "success" | "partial" | "failed";
  error?: string;
}

export interface PullRunSummary {
  source_id: string;
  source_type: PullSourceType;
  started_at: string;
  finished_at: string;
  streams: PullStreamSummary[];
}
