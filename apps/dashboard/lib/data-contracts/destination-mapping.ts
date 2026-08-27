import "server-only";
import { bigQueryRowForEvent, type BqSchemaField } from "@axel/shared";
import type { InferredDataContract } from "./inference";
import type { SampledEvent } from "./sampler";

/**
 * Output of a destination-mapping proposal. Persisted into
 * `data_contract_versions.destination_mapping`. Discriminated by `kind` so the
 * UI can switch off it without knowing about every shape.
 */
export type DestinationMapping =
  | PostgresMapping
  | MongoMapping
  | BigQueryMapping
  | WebhookMapping;

export interface BaseMapping {
  destination_id: string;
  /** Repository writes strip this transient proposal field before storage. */
  preview: PreviewRow[];
  rationale: string;
}

export interface PreviewRow {
  event_id: string;
  before: unknown;
  after: unknown;
}

export interface PostgresMapping extends BaseMapping {
  kind: "postgres";
  table: string;
  /** "jsonb" stores the entire payload in a single `payload jsonb` column;
   *  "columns" assigns each source field to a target column. */
  mode: "jsonb" | "columns";
  /** payload-jsonb column name (when mode='jsonb'). */
  jsonb_column?: string;
  /** path-to-column map (when mode='columns'). */
  column_assignments?: Record<string, string>;
  /** Suggested idempotency / dedup key column, if one was identifiable. */
  idempotency_column: string | null;
}

export interface MongoMapping extends BaseMapping {
  kind: "mongodb";
  collection: string;
  /** Path within the source payload to use as Mongo `_id`. Null if none chosen. */
  id_path: string | null;
  /** Path-keyed list of fields to PROJECT into the doc (empty = all). */
  projected_paths: string[];
}

export interface WebhookMapping extends BaseMapping {
  kind: "webhook";
  /** Outbound body strategy: pass through the source payload, or wrap it
   *  in a small envelope with event_type + occurred_at + data. */
  body_strategy: "passthrough" | "envelope";
  /** Headers we'll set on outbound requests (in addition to signature). */
  headers: Record<string, string>;
}

export interface BigQueryMapping extends BaseMapping {
  kind: "bigquery";
  dataset: string;
  table: string;
  /** Keep source JSON types and nested records in queryable BigQuery columns. */
  mode: "typed_records";
}

// ---------------------------------------------------------------------------
// Destination-shape introspection inputs. Adapters live elsewhere.
// ---------------------------------------------------------------------------

export interface PostgresIntrospection {
  table: string;
  columns: Array<{
    name: string;
    data_type: string;
    is_nullable: boolean;
    /** True if this column has a unique constraint or is the PK. */
    is_unique: boolean;
  }>;
}

export interface MongoIntrospection {
  collection: string;
  /** Sampled field names observed in the collection. Used as a hint, not authoritative. */
  observed_fields: string[];
}

export interface WebhookIntrospection {
  /** Signing header name the existing webhook destination already uses. */
  signature_header: string;
}

export type BigQueryIntrospection =
  | { kind: "schema"; dataset: string; table: string; fields: BqSchemaField[] }
  | { kind: "missing"; dataset: string; table: string };

export function proposeBigQueryMapping(
  destinationId: string,
  introspection: BigQueryIntrospection,
  samples: SampledEvent[],
): BigQueryMapping {
  const { dataset, table } = introspection;
  return {
    kind: "bigquery",
    destination_id: destinationId,
    dataset,
    table,
    mode: "typed_records",
    rationale:
      introspection.kind === "missing"
        ? `Table \`${dataset}.${table}\` does not exist yet. Axel will create it with nested, type-preserving columns on first delivery.`
        : `Write nested, type-preserving records into \`${dataset}.${table}\`; the existing table has ${introspection.fields.length} top-level field${introspection.fields.length === 1 ? "" : "s"}.`,
    preview: samples.slice(0, 3).map((sample) => ({
      event_id: sample.event_id,
      before: sample.payload,
      after: bigQueryRowForEvent(sample.payload, "typed_records"),
    })),
  };
}

// ---------------------------------------------------------------------------
// Postgres proposal
// ---------------------------------------------------------------------------

const PG_JSONB_TYPES = new Set(["jsonb", "json"]);
const PG_TEXT_TYPES = new Set([
  "text",
  "character varying",
  "varchar",
  "char",
  "uuid",
]);
const PG_INT_TYPES = new Set([
  "integer",
  "bigint",
  "smallint",
  "numeric",
  "double precision",
  "real",
]);
const PG_BOOL_TYPES = new Set(["boolean"]);
const PG_TS_TYPES = new Set([
  "timestamp with time zone",
  "timestamptz",
  "timestamp without time zone",
  "timestamp",
  "date",
]);

const IDEMPOTENCY_PREFERRED_NAMES = [
  "event_id",
  "external_id",
  "idempotency_key",
  "id",
];

export function proposePostgresMapping(
  destinationId: string,
  introspection: PostgresIntrospection,
  inferred: InferredDataContract,
  samples: SampledEvent[],
): PostgresMapping {
  const columnsByName = new Map(
    introspection.columns.map((c) => [c.name.toLowerCase(), c]),
  );

  // Try column-level matching: for each non-array, non-object inferred field,
  // see if a same-named column exists with a compatible type.
  const assignments: Record<string, string> = {};
  let columnMatches = 0;
  let columnableFields = 0;
  for (const [path, spec] of Object.entries(inferred.fields)) {
    if (path === "$") continue;
    if (spec.types.includes("object") || spec.types.includes("array")) continue;
    if (path.includes("[]")) continue;
    columnableFields += 1;
    const leaf = path.split(".").pop()!.toLowerCase();
    const candidate = columnsByName.get(leaf);
    if (!candidate) continue;
    if (isCompatible(spec.types, candidate.data_type)) {
      assignments[path] = candidate.name;
      columnMatches += 1;
    }
  }

  // Strict threshold: only propose columns mode if ≥80% of leaf primitive
  // fields landed AND there's at least one column to assign. Otherwise
  // fall back to a single jsonb blob.
  const matchRatio = columnableFields > 0 ? columnMatches / columnableFields : 0;
  const jsonbColumn = pickJsonbColumn(introspection);
  const idempotencyColumn = pickIdempotencyColumn(
    introspection,
    inferred,
  );

  if (matchRatio >= 0.8 && columnMatches > 0) {
    return {
      kind: "postgres",
      destination_id: destinationId,
      table: introspection.table,
      mode: "columns",
      column_assignments: assignments,
      idempotency_column: idempotencyColumn,
      rationale: `Matched ${columnMatches}/${columnableFields} leaf primitive fields to columns by name + type compatibility.`,
      preview: buildPostgresColumnsPreview(samples, assignments),
    };
  }
  return {
    kind: "postgres",
    destination_id: destinationId,
    table: introspection.table,
    mode: "jsonb",
    jsonb_column: jsonbColumn,
    idempotency_column: idempotencyColumn,
    rationale: jsonbColumn
      ? `Found JSONB column \`${jsonbColumn}\` — store the full event payload there.`
      : "No JSONB column found; suggest adding one to the destination table.",
    preview: buildPostgresJsonbPreview(samples, jsonbColumn ?? "payload"),
  };
}

function isCompatible(sourceTypes: string[], pgType: string): boolean {
  const pg = pgType.toLowerCase();
  if (PG_JSONB_TYPES.has(pg)) return true;
  if (sourceTypes.includes("null") && sourceTypes.length === 1) return true;
  const effective = sourceTypes.filter((t) => t !== "null");
  if (effective.length === 0) return false;
  for (const t of effective) {
    if (t === "string" && (PG_TEXT_TYPES.has(pg) || PG_TS_TYPES.has(pg))) continue;
    if (t === "number" && (PG_INT_TYPES.has(pg) || PG_TS_TYPES.has(pg))) continue;
    if (t === "boolean" && PG_BOOL_TYPES.has(pg)) continue;
    return false;
  }
  return true;
}

function pickJsonbColumn(intro: PostgresIntrospection): string | undefined {
  const jsonbCols = intro.columns.filter((c) =>
    PG_JSONB_TYPES.has(c.data_type.toLowerCase()),
  );
  if (jsonbCols.length === 0) return undefined;
  // Prefer a column literally named `payload`/`event`/`data`.
  for (const preferred of ["payload", "event", "data", "body"]) {
    const hit = jsonbCols.find((c) => c.name.toLowerCase() === preferred);
    if (hit) return hit.name;
  }
  return jsonbCols[0]!.name;
}

function pickIdempotencyColumn(
  intro: PostgresIntrospection,
  inferred: InferredDataContract,
): string | null {
  const uniqueCols = intro.columns.filter((c) => c.is_unique);
  if (uniqueCols.length === 0) return null;
  const uniqueByName = new Map(
    uniqueCols.map((c) => [c.name.toLowerCase(), c]),
  );

  // 1. Walk id candidates in inference order — the highest-uniqueness
  //    candidate that matches a unique column wins, even when the column
  //    list is in a different order.
  for (const id of inferred.ids) {
    const leaf = id.path.split(".").pop()!.toLowerCase();
    const hit = uniqueByName.get(leaf);
    if (hit) return hit.name;
  }
  // 2. Fall back to the conventional preferred-name list.
  for (const name of IDEMPOTENCY_PREFERRED_NAMES) {
    const hit = uniqueByName.get(name);
    if (hit) return hit.name;
  }
  // 3. Any unique column is better than nothing.
  return uniqueCols[0]!.name;
}

function buildPostgresColumnsPreview(
  samples: SampledEvent[],
  assignments: Record<string, string>,
): PreviewRow[] {
  return samples.slice(0, 3).map((s) => {
    const after: Record<string, unknown> = {};
    for (const [path, col] of Object.entries(assignments)) {
      after[col] = readPath(s.payload, path);
    }
    return { event_id: s.event_id, before: s.payload, after };
  });
}

function buildPostgresJsonbPreview(
  samples: SampledEvent[],
  jsonbColumn: string,
): PreviewRow[] {
  return samples.slice(0, 3).map((s) => ({
    event_id: s.event_id,
    before: s.payload,
    after: { [jsonbColumn]: s.payload },
  }));
}

// ---------------------------------------------------------------------------
// Mongo proposal
// ---------------------------------------------------------------------------

export function proposeMongoMapping(
  destinationId: string,
  introspection: MongoIntrospection,
  inferred: InferredDataContract,
  samples: SampledEvent[],
): MongoMapping {
  const idPath = pickMongoIdPath(inferred);
  const projected = pickMongoProjectedPaths(inferred);
  return {
    kind: "mongodb",
    destination_id: destinationId,
    collection: introspection.collection,
    id_path: idPath,
    projected_paths: projected,
    rationale: idPath
      ? `Use \`${idPath}\` as the Mongo \`_id\` for natural idempotency.`
      : "No stable ID candidate found — Mongo will assign ObjectIds. Replays may insert duplicates.",
    preview: samples.slice(0, 3).map((s) => ({
      event_id: s.event_id,
      before: s.payload,
      after: buildMongoDoc(s.payload, idPath, projected),
    })),
  };
}

function pickMongoIdPath(inferred: InferredDataContract): string | null {
  const best = inferred.ids
    .filter((c) => c.uniqueness >= 0.9)
    .sort((a, b) => b.uniqueness - a.uniqueness)[0];
  return best?.path ?? null;
}

function pickMongoProjectedPaths(inferred: InferredDataContract): string[] {
  // Default to passing everything through. Drop fields explicitly marked
  // sensitive (deterministic detection) unless the user later overrides —
  // the saved version's field_annotations carries that signal.
  return Object.keys(inferred.fields)
    .filter((p) => p !== "$" && !p.endsWith("[]"))
    .filter((p) => !inferred.sensitive_fields.some((s) => s.path === p))
    .slice(0, 200);
}

function buildMongoDoc(
  payload: unknown,
  idPath: string | null,
  projected: string[],
): unknown {
  if (projected.length === 0) {
    return idPath ? { _id: readPath(payload, idPath), ...((payload as object) || {}) } : payload;
  }
  const out: Record<string, unknown> = {};
  if (idPath) out._id = readPath(payload, idPath);
  for (const path of projected) {
    setPath(out, path, readPath(payload, path));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Webhook proposal
// ---------------------------------------------------------------------------

export function proposeWebhookMapping(
  destinationId: string,
  _introspection: WebhookIntrospection,
  inferred: InferredDataContract,
  samples: SampledEvent[],
): WebhookMapping {
  // Use envelope mode when we can identify an event type + timestamp, so
  // downstream receivers can route + dedupe without re-inferring. Otherwise
  // passthrough is simpler and avoids inventing fields the source didn't
  // emit.
  const hasType = inferred.status_fields.some((s) =>
    ["type", "event", "event_type"].includes(s.path.split(".").pop()!),
  );
  const strategy: WebhookMapping["body_strategy"] = hasType ? "envelope" : "passthrough";
  const headers = {
    "content-type": "application/json",
    "x-axel-data-contract": "v1",
  };
  return {
    kind: "webhook",
    destination_id: destinationId,
    body_strategy: strategy,
    headers,
    rationale:
      strategy === "envelope"
        ? "Source emits a recognizable event-type field — wrap the payload in an envelope so receivers can route on it."
        : "No event-type signal — forward the source payload verbatim. The signature header will be added by the delivery layer.",
    preview: samples.slice(0, 3).map((s) => ({
      event_id: s.event_id,
      before: s.payload,
      after:
        strategy === "envelope"
          ? buildEnvelope(s.payload, inferred)
          : s.payload,
    })),
  };
}

function buildEnvelope(payload: unknown, inferred: InferredDataContract): unknown {
  const typePath =
    inferred.status_fields.find((s) =>
      ["type", "event", "event_type"].includes(s.path.split(".").pop()!),
    )?.path ?? "type";
  const tsPath = inferred.timestamps[0]?.path;
  return {
    event_type: readPath(payload, typePath) ?? null,
    occurred_at: tsPath ? readPath(payload, tsPath) : null,
    data: payload,
  };
}

// ---------------------------------------------------------------------------
// Internal: shared path helpers (a thin local copy of the inference module's
// readers, so we don't leak server-only imports across files unnecessarily).
// ---------------------------------------------------------------------------

function readPath(value: unknown, path: string): unknown {
  if (!path || path === "$") return value;
  const parts = path.split(".");
  let cur: unknown = value;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    const key = part.replace(/\[\]$/, "");
    if (Array.isArray(cur)) {
      cur = cur[0];
      if (key === "") continue;
    }
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!.replace(/\[\]$/, "");
    if (!(key in cur) || typeof cur[key] !== "object" || cur[key] === null) {
      cur[key] = {};
    }
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!.replace(/\[\]$/, "")] = value;
}
