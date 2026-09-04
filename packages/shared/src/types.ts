import type { SubjectKeyPath } from "./subject-key.js";
import type { SourceProvider } from "./signature-verify.js";

export type ISO8601 = string;

/**
 * Edge-cached billing gate for a workspace. Pushed by the dashboard
 * (after the hourly rollup and on Stripe webhook plan changes) to
 * the ingest worker via /admin/workspace-plan/put. The ingest worker
 * reads it on every request after source resolution to decide
 * whether to accept, return 429 (free over cap), or 402 (suspended
 * for non-payment). See axelapp.ai/pricing.
 */
export type WorkspacePlanGate = "accept" | "reject_quota" | "reject_suspended";

export interface WorkspacePlanState {
  workspace_id: string;
  /** Pricing-tier plan id. */
  plan: "free" | "pro" | "enterprise";
  /** Combined ingest gate decision derived from plan + billing_status + usage. */
  gate: WorkspacePlanGate;
  /** ISO timestamp the gate was last computed in the control plane. */
  computed_at: ISO8601;
}


export interface Event {
  event_id: string;
  workspace_id: string;
  source_id: string;
  received_at: ISO8601;
  r2_key: string;
  headers: Record<string, string>;
  query: Record<string, string>;
  size_bytes: number;
}

export interface Source {
  source_id: string;
  workspace_id: string;
  name: string;
  secret_token: string;
  status: "active" | "disabled";
  // Optional per-source overrides for the ingest input-shape caps. When unset,
  // the ingest worker falls back to the global defaults from its Env. Set on
  // a hostile/leaky source to tighten without changing the global cap.
  max_body_bytes?: number;
  max_body_depth?: number;
  max_events_per_minute?: number;
  /**
   * Provider-specific signature scheme (AXE-23). When set to anything other
   * than "custom" with a `signing_secret`, the ingest worker rejects requests
   * that fail the provider's HMAC check BEFORE writing to R2 or enqueuing.
   *
   * - `custom`  — no provider preset; x-axel-token header auth.
   *               If `signing_secret` is also set, the worker verifies our
   *               own `X-Axel-Signature: t=…,v1=…` HMAC scheme on top of
   *               the secret token check.
   * Named providers authenticate with their provider signature and do not use
   * an Axel source token.
   * - `stripe`  — verifies `Stripe-Signature: t=…,v1=…`.
   * - `github`  — verifies `X-Hub-Signature-256: sha256=…`.
   * - `shopify` — verifies `X-Shopify-Hmac-Sha256: <base64>`.
   * - `chargebee` — verifies Chargebee's HTTP Basic authorization header.
   */
  provider?: SourceProvider;
  /**
   * The plaintext provider signing secret. Stored encrypted at rest in
   * Postgres (AES-256-GCM under CREDENTIALS_MASTER_KEY). Delivery service
   * decrypts it for origin lookups. The edge authority holds the live source
   * only in isolate memory and persists a config digest; mutations fence the
   * source before the database write and publish fresh committed state before
   * it can authorize again.
   * Empty / undefined = no signature verification (token-only).
   */
  signing_secret?: string;
  /**
   * Previous signing secret, kept during a rotation overlap window so webhooks
   * still signed with the old secret keep verifying. The ingest worker accepts
   * a signature matching EITHER signing_secret or signing_secret_previous.
   * Cleared once the window passes. Empty/undefined = no previous secret.
   */
  signing_secret_previous?: string;
  /**
   * PII redaction (dot-paths, `[]` to descend arrays) applied to the JSON body
   * at ingest BEFORE the R2 write, so the masked fields never persist and are
   * never delivered. Empty/undefined = no redaction (default).
   */
  redact_paths?: string[];
  /**
   * AXE-34 — optional inbound IP allowlist. When set, the ingest
   * worker rejects requests whose `cf-connecting-ip` is not in any
   * of the listed CIDRs with HTTP 403 (non-billable). Empty / unset
   * means no allowlist (any IP accepted). Stored as text array, e.g.
   * ["3.18.12.63/32", "13.107.6.152/31"].
   */
  inbound_ip_allowlist?: string[];
  /**
   * FIFO / ordered delivery (Phase 1). When `ordering_enabled` is true the
   * ingest worker resolves an `ordering_key` per event — from
   * `ordering_key_header` (case-insensitive, wins when present) or otherwise
   * the dot-path `ordering_key_path` into the JSON body — and co-locates
   * same-key events on one shard. The raw value is HMAC-pseudonymized before
   * Queue or Durable Object use. Later phases serialize delivery per key.
   * Default-off: when unset, events shard by event_id exactly as before and a
   * missing/unresolvable key falls back to the unordered path (never dropped).
   */
  ordering_enabled?: boolean;
  ordering_key_header?: string;
  ordering_key_path?: string;
  /**
   * GDPR per-subject erasure (Phase 1 foundation). Operator-configured paths to
   * the subject identifier(s) on an event — body dot-paths and/or header/query
   * names. A later phase indexes the extracted values (hashed) at ingest so an
   * erasure request is a cheap lookup. Default NULL/undefined = no extraction,
   * no index rows, byte-identical ingest.
   */
  subject_key_paths?: SubjectKeyPath[] | null;
  /**
   * Source-level delivery projection. It is carried in the edge source
   * authority alongside the ingest fields so every control-plane path
   * publishes the same shape. Ingest does not apply the projection;
   * routers do when they fan out the event.
   */
  field_selection?: string[] | null;
}

/**
 * "legacy_js" routes carry a JavaScript filter/transform that requires the
 * Node Worker-Threads sandbox. The edge router still dead-letters these
 * (no eval available in CF Workers); they'll execute when traffic flows
 * through the Node router.
 *
 * "declarative" routes carry JSON declarations of the route engine DSL
 * (see route-engine.ts). The edge router executes them inline, no eval.
 * Event-Maps-generated routes use this engine.
 */
export type RouteEngineKind = "legacy_js" | "declarative";

export interface Route {
  route_id: string;
  workspace_id: string;
  source_id: string;
  status: "active" | "disabled" | "errored";
  engine?: RouteEngineKind;
  filter_expression?: string;
  transform_script?: string;
  destination_ids: string[];
  /**
   * Per-destination binding for this route. Keyed by destination_id.
   * The router copies the relevant binding onto each fan-out queue
   * message so connectors can write to the right table/collection
   * without a per-attempt DB read. Missing entries fall back to the
   * destination's `config` for back-compat.
   */
  destination_bindings?: Record<string, RouteDestinationBinding | null>;
  /**
   * Optional DAG pipeline_graph (see route-engine.ts). When non-null
   * the router executes via `executeGraph` and emits one delivery per
   * leaf — `filter_expression` and `transform_script` MUST be unset
   * (enforced by DB CHECK constraint `routes_pipeline_graph_excludes_legacy`).
   * When null the router uses the legacy single-filter/single-transform
   * uniform-fan-out path verbatim (byte-equivalent semantics).
   */
  pipeline_graph?: string | null;
  /**
   * The SOURCE's field-selection paths (dotted), applied to the delivered
   * payload so destinations only receive the operator-selected fields. Same
   * value for every route on a source; the Node router projects with it at
   * fan-out, mirroring router-edge. Null/empty = deliver the full payload.
   */
  field_selection?: string[] | null;
}

export type DestinationType =
  | "mongodb"
  | "postgres"
  | "r2"
  | "s3"
  | "http"
  /**
   * Signed outbound webhook. Like "http", but every request is HMAC-signed,
   * timestamped, and accompanied by a delivery id so the receiver can verify
   * authenticity and deduplicate. This is the destination type customers
   * subscribe to when they want to *send* webhooks downstream — Axel is the
   * source of truth, and the receiver verifies signatures against a shared
   * secret. Modeled on Hookdeck Outpost.
   */
  | "webhook"
  /**
   * Databricks SQL Warehouse — INSERT each event into a Delta table via the
   * Statement Execution REST API. Simple ergonomics ("rows just appear") but
   * caps out at low/moderate throughput because every INSERT is a separate
   * Delta commit.
   */
  | "databricks_sql"
  /**
   * Databricks Unity Catalog Volume — drop JSON files into a Volume via the
   * Files API. Customer points Auto Loader at the volume for streaming
   * ingest into Delta. Scales horizontally; the recommended high-throughput
   * pattern.
   */
  | "databricks_volume"
  /**
   * Google BigQuery — stream each event into a table via the legacy
   * streaming `tabledata.insertAll` REST endpoint. Auth is a Google service
   * account: the connector signs a short-lived JWT and exchanges it for an
   * OAuth access token. `insertId` carries the Axel event id for BigQuery's
   * best-effort streaming dedup. Runs in the native (Node) delivery runtime
   * because it needs RSA-SHA256 JWT signing.
   */
  | "bigquery";

export const NATIVE_RUNTIME_DESTINATION_TYPES = [
  "mongodb",
  "postgres",
  "databricks_sql",
  "databricks_volume",
  "bigquery",
] as const satisfies readonly DestinationType[];

const NATIVE_RUNTIME_DESTINATION_TYPE_SET = new Set<string>(NATIVE_RUNTIME_DESTINATION_TYPES);

export function isNativeRuntimeDestinationType(
  type: string | null | undefined,
): type is (typeof NATIVE_RUNTIME_DESTINATION_TYPES)[number] {
  return typeof type === "string" && NATIVE_RUNTIME_DESTINATION_TYPE_SET.has(type);
}

export function isParquetObjectStoreBinding(
  binding: RouteDestinationBinding | null | undefined,
): binding is ObjectStoreBinding & { format: "parquet" } {
  return (
    !!binding
    && typeof binding === "object"
    && !Array.isArray(binding)
    && (binding as { format?: unknown }).format === "parquet"
  );
}

export function requiresNativeRuntimeDestination(
  type: string | null | undefined,
  binding?: RouteDestinationBinding | null,
): boolean {
  if (isNativeRuntimeDestinationType(type)) return true;
  return type === "s3" && isParquetObjectStoreBinding(binding);
}

export interface Destination<TConfig = unknown> {
  destination_id: string;
  workspace_id: string;
  type: DestinationType;
  config: TConfig;
  credentials_ref: string;
}

/**
 * Per-route binding stored on `route_destinations.binding`.
 *
 * Lets a single service-level destination (Postgres conn string,
 * Mongo cluster, S3 bucket, Databricks workspace) fan out to many
 * targets via separate routes — each route picks its own
 * table/collection/prefix.
 *
 * NULL bindings fall back to the destination's `config` fields for
 * back-compat with pre-AXE-binding rows. New code should read the
 * binding first.
 */
export type RouteDestinationBinding =
  | PostgresBinding
  | MongoBinding
  | DatabricksSqlBinding
  | DatabricksVolumeBinding
  | BigQueryBinding
  | ObjectStoreBinding
  | EmptyBinding;

export interface PostgresBinding {
  table: string;
  /**
   * `jsonb_blob`   — each event becomes one row with the entire body
   *                  in a single jsonb column (`payload_column`).
   * `dotted_columns` — flatten payload keys with dot-notation and
   *                  auto-create columns. Nested `{user: {email: ...}}`
   *                  becomes column `"user.email"`. New keys trigger
   *                  `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
   */
  mode: "jsonb_blob" | "dotted_columns";
  /** Only used for `jsonb_blob` mode. Defaults to "payload". */
  payload_column?: string;
}

export interface MongoBinding {
  collection: string;
  idempotency_field?: string;
}

export interface DatabricksSqlBinding {
  table: string;
  /**
   * `json_column` (default) — each event's JSON body is stored as a string in
   *   a single column (`payload_column`, default "payload"). No per-field
   *   schema; the table must already exist.
   * `typed_columns` — the event is flattened into one typed column per leaf
   *   (number → BIGINT/DOUBLE, boolean → BOOLEAN, string → STRING; nested
   *   objects/arrays → STRING JSON), preserving source types. Axel creates the
   *   Delta table and adds new columns as they appear. A value whose type
   *   conflicts with an existing column dead-letters.
   */
  mode?: "json_column" | "typed_columns";
  /** Only used for `json_column` mode. Defaults to "payload". */
  payload_column?: string;
}

export interface DatabricksVolumeBinding {
  volume: string;
  key_prefix?: string;
  key_template?: string;
}

export interface BigQueryBinding {
  /** Target dataset within the destination's project. */
  dataset: string;
  /** Target table id within `dataset`. */
  table: string;
  /**
   * `nested_records` — recommended for new routes. JSON objects become
   *                    recursive BigQuery RECORD fields, scalar leaves are
   *                    normalized to STRING for schema-drift tolerance, and
   *                    compatible object arrays become REPEATED RECORD fields.
   *                    Primitive arrays become REPEATED STRING fields. The
   *                    connector creates the table when needed and evolves
   *                    nested fields additively as new keys appear.
   * `columns`        — legacy flattened-warehouse shape. Nested leaf paths
   *                    become underscore-joined STRING columns (for example,
   *                    `data_subscriber_email`) and new columns are added
   *                    automatically.
   * `json_column`    — each event becomes one row with the body stored as a
   *                    string in a single column (`payload_column`, default
   *                    "payload"). Robust: no per-field schema to maintain.
   * `typed_records`  — like `nested_records`, but scalar leaves keep the
   *                    source JSON type: number → INT64/FLOAT64, boolean →
   *                    BOOL, string → STRING (objects → RECORD, arrays →
   *                    REPEATED). Best for a clean, stable schema. Type drift
   *                    on an existing column dead-letters the row (BigQuery
   *                    can't widen a column's type in place), so validate with
   *                    the pre-flight compatibility check first.
   *
   * An omitted mode retains the legacy `json_column` behavior for existing
   * bindings. New dashboard-created bindings explicitly use `nested_records`.
   */
  mode?: "nested_records" | "json_column" | "columns" | "typed_records";
  /** Only used for `json_column` mode. Defaults to "payload". */
  payload_column?: string;
}

export interface ObjectStoreBinding {
  /** S3 / R2 — bucket lives on the destination, prefix is per-route. */
  key_prefix?: string;
  key_template?: string;
  /**
   * JSON keeps the legacy one-object-per-event writer. Parquet is S3-only and
   * routes to the native delivery runtime so events can be batched before PUT.
   */
  format?: "json" | "parquet";
  parquet_batch_max_rows?: number;
  parquet_flush_interval_ms?: number;
  /**
   * Flush a Parquet batch once this many (uncompressed) payload bytes have
   * accumulated. This is the primary lever against the small-files problem:
   * it produces roughly target-sized objects at any throughput, while
   * `parquet_flush_interval_ms` is only the low-volume backstop.
   */
  parquet_target_bytes?: number;
}

/** http / webhook — URL is the destination; no per-route binding. */
export type EmptyBinding = Record<string, never>;

export type DeliveryStatus = "pending" | "success" | "retry" | "dead";

export interface DeliveryAttempt {
  attempt_id: string;
  event_id: string;
  destination_id: string;
  status: DeliveryStatus;
  response: unknown;
  latency_ms: number;
  created_at: ISO8601;
}

export interface QueueMessage {
  event_id: string;
  workspace_id: string;
  source_id: string;
  r2_key: string;
  received_at: ISO8601;
  content_type: string;
  size_bytes: number;
  shard: number;
  /** Value-free by policy. Raw request header values never leave ingest. */
  headers: Record<string, string>;
  /** Value-free by policy. Raw query values never leave ingest. */
  query: Record<string, string>;
  is_test: boolean;
  /**
   * Bounded canonical type from an authenticated named provider. Custom,
   * admin-triggered, and pull-source events omit it so arbitrary customer
   * body or header values cannot enter the analytics index.
   */
  event_type?: string;
  /**
   * FIFO / ordered delivery (Phase 1). Present only when the source opted into
   * ordered delivery AND a key resolved. It is a domain-separated keyed HMAC
   * over workspace, source, and the raw scalar; Queue and serializers never
   * receive the raw value. Absent (not null) for unordered events.
   */
  ordering_key?: string;
}

export interface DestinationQueueMessage {
  /**
   * Runtime-validated wire contract version.
   *
   * Version 1 is the first explicit version. The delivery-service accepts the
   * otherwise-identical unversioned shape as legacy version 0 during rolling
   * upgrades, then normalizes it to version 1 before any delivery code sees
   * it. Producers must always stamp the current version.
   */
  queue_message_version: 1;
  event_id: string;
  workspace_id: string;
  source_id: string;
  route_id: string;
  destination_id: string;
  r2_key: string;
  received_at: ISO8601;
  enqueued_at: ISO8601;
  attempt_no: number;
  max_attempts: number;
  idempotency_key: string;
  next_attempt_at?: ISO8601;
  content_type: string;
  size_bytes: number;
  payload: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
  is_test: boolean;
  /**
   * Per-route binding from `route_destinations.binding`. The router
   * copies this onto the queue message at fan-out so the connector
   * can pick its target (postgres table, mongo collection, S3 prefix,
   * etc.) without a per-attempt DB read.
   *
   * Optional: NULL binding means the connector falls back to the
   * destination's `config` fields (legacy rows pre-binding).
   */
  binding?: RouteDestinationBinding | null;
  /**
   * When the inline `{ payload, headers, query }` would push the JSON
   * representation of this message past Cloudflare Queues' 128KB body
   * limit, the producer spills those three fields to R2 under this key
   * and zeros them out on the wire. Consumers must hydrate from R2
   * before reading the payload, then delete the key on terminal
   * outcome (success or dead-letter).
   *
   * Absent on small messages — the inline fields are authoritative.
   */
  spill_r2_key?: string | null;
  /**
   * FIFO / ordered delivery (Phase 2). Present only when this delivery was
   * dispatched by the per-key ordering Durable Object. Format `${doId}:${seq}`.
   * The delivery worker echoes it back to the DO via `report` on terminal
   * outcome so the key advances to its next event. Absent for the unordered
   * default path. See ordering-core.ts.
   */
  ordering_token?: string;
}

export interface RetryPolicy {
  max_attempts: number;
  base_delay_ms: number;
  max_delay_ms: number;
  jitter_ratio: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  max_attempts: 12,
  base_delay_ms: 1_000,
  max_delay_ms: 15 * 60_000,
  jitter_ratio: 0.2,
};

export function deliveryIdempotencyKey(input: {
  workspace_id: string;
  event_id: string;
  route_id: string;
  destination_id: string;
  /**
   * Pipeline-graph leaf node id. Optional — when absent (legacy routes),
   * the key is byte-equivalent to the pre-DAG shape so existing
   * `delivery_idempotency` rows continue matching. When present (graph
   * routes), the leaf_node_id is appended so two leaves landing at the
   * same destination produce distinct keys and don't silently dedupe.
   */
  leaf_node_id?: string;
}): string {
  const base = [
    input.workspace_id,
    input.event_id,
    input.route_id,
    input.destination_id,
  ].join(":");
  return input.leaf_node_id ? `${base}:${input.leaf_node_id}` : base;
}

export function retryDelayMs(
  attemptNo: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptNo - 1);
  const raw = Math.min(policy.max_delay_ms, policy.base_delay_ms * 2 ** exponent);
  const jitter = raw * policy.jitter_ratio * random();
  return Math.floor(raw + jitter);
}

export const SHARD_COUNT = 16;

export function shardFor(eventId: string): number {
  let h = 2166136261;
  for (let i = 0; i < eventId.length; i++) {
    h ^= eventId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % SHARD_COUNT;
}
