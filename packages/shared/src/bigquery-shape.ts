/**
 * Model the BigQuery table schema Axel WOULD write for a set of sample event
 * bodies, per write mode. Used by the pre-flight compatibility check to diff
 * against an existing table's declared schema.
 *
 * This mirrors the delivery-service BigQuery connector's shaping rules
 * (apps/delivery-service/src/connectors/bigquery.ts — the source of truth):
 *   - json_column: the whole body goes in one STRING column.
 *   - columns: every leaf is flattened to an underscore-joined STRING column.
 *   - nested_records: object hierarchy is preserved as RECORD fields, but every
 *     SCALAR leaf is normalized to STRING; a non-null primitive array becomes
 *     REPEATED STRING; a uniform object array becomes REPEATED RECORD; anything
 *     that can't map losslessly (mixed/nested/partially-null arrays, incompatible
 *     object arrays) is preserved in a sibling `<field>__json` STRING column.
 *
 * The decisive consequence for compatibility: because scalar leaves are always
 * STRING, an existing table with typed columns (INT64/FLOAT64/TIMESTAMP/BOOL/…)
 * will NOT match and BigQuery will reject those rows. This module makes that
 * visible before delivery.
 */

export type BqFieldMode = "NULLABLE" | "REPEATED" | "REQUIRED";

export interface BqSchemaField {
  name: string;
  /** BigQuery type: STRING, RECORD, INT64, FLOAT64, BOOL, TIMESTAMP, … */
  type: string;
  mode: BqFieldMode;
  /** Present when type === "RECORD". */
  fields?: BqSchemaField[];
}

export type BigQueryWriteMode = "json_column" | "columns" | "nested_records" | "typed_records";

/**
 * Per-leaf BigQuery type for `typed_records` mode: preserve the source JSON
 * type instead of normalizing to STRING. Null must be filtered out before this.
 */
export function inferBqScalarType(value: unknown): string {
  if (typeof value === "boolean") return "BOOL";
  if (typeof value === "number") return Number.isInteger(value) ? "INT64" : "FLOAT64";
  return "STRING"; // strings (and any other scalar) stay STRING
}

/**
 * Widen two observed scalar types toward a common one, mirroring the Postgres
 * connector's lattice (packages/shared/pg-columns.ts `widenPgType`): the only
 * lossless numeric merge is INT64 + FLOAT64 → FLOAT64; every other mismatch
 * falls back to STRING, the universal sink. One-directional — never narrows.
 */
export function widenBqScalar(a: string, b: string): string {
  if (a === b) return a;
  if ((a === "INT64" || a === "FLOAT64") && (b === "INT64" || b === "FLOAT64")) return "FLOAT64";
  return "STRING";
}

/** Sanitize a raw JSON key to a valid BigQuery column name (connector parity). */
export function bigQueryFieldName(rawKey: string): string {
  let name = rawKey.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length === 0) name = "_";
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return name.slice(0, 300);
}

/**
 * The schema Axel would create/evolve toward for these sample bodies + mode.
 * Samples that are not JSON objects are ignored (the connector dead-letters
 * them for object modes). Returns [] when nothing usable is present.
 */
export function expectedBigQuerySchema(
  samples: unknown[],
  mode: BigQueryWriteMode,
  payloadColumn = "payload",
): BqSchemaField[] {
  if (mode === "json_column") {
    return [{ name: payloadColumn, type: "STRING", mode: "NULLABLE" }];
  }
  // typed_records reuses the value shaper's field output (same rules as the
  // delivered row) and merges with type widening; nested_records/columns keep
  // their STRING-normalized shapers.
  const typed = mode === "typed_records";
  let merged: BqSchemaField[] = [];
  for (const sample of samples) {
    if (!sample || typeof sample !== "object" || Array.isArray(sample)) continue;
    const fields =
      mode === "columns"
        ? columnFields(sample as Record<string, unknown>)
        : typed
          ? shapeRecordValue(sample as Record<string, unknown>, true).fields
          : recordFields(sample as Record<string, unknown>);
    merged = mergeFields(merged, fields, typed);
  }
  return merged;
}

// ---- columns mode --------------------------------------------------------- //

function columnFields(obj: Record<string, unknown>): BqSchemaField[] {
  const out: BqSchemaField[] = [];
  const seen = new Set<string>();
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [rawKey, v] of Object.entries(node)) {
      let seg = rawKey.replace(/[^A-Za-z0-9_]/g, "_");
      if (/^[0-9]/.test(seg)) seg = `_${seg}`;
      const key = prefix ? `${prefix}_${seg}` : seg;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        addColumn(out, seen, key);
      } else if (typeof v === "object") {
        walk(v as Record<string, unknown>, key);
      } else {
        addColumn(out, seen, key);
      }
    }
  };
  walk(obj, "");
  return out;
}

function addColumn(out: BqSchemaField[], seen: Set<string>, key: string): void {
  const lower = key.toLowerCase();
  if (seen.has(lower)) return;
  seen.add(lower);
  // columns mode stringifies every value, so every column is STRING.
  out.push({ name: key, type: "STRING", mode: "NULLABLE" });
}

// ---- nested_records mode -------------------------------------------------- //

function recordFields(obj: Record<string, unknown>): BqSchemaField[] {
  let fields: BqSchemaField[] = [];
  for (const [rawName, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const shaped = shapeValue(bigQueryFieldName(rawName), value);
    if (!shaped) continue;
    fields = mergeFields(fields, [shaped]);
  }
  return fields;
}

/** Shape one value into a BigQuery field, or null when it carries no type. */
function shapeValue(name: string, value: unknown): BqSchemaField | null {
  if (Array.isArray(value)) return shapeArray(name, value);
  if (value !== null && typeof value === "object") {
    const fields = recordFields(value as Record<string, unknown>);
    if (fields.length === 0) return null; // empty/all-null object → no type yet
    return { name, type: "RECORD", mode: "NULLABLE", fields };
  }
  // scalar (string/number/boolean) or null → STRING leaf
  return { name, type: "STRING", mode: "NULLABLE" };
}

function shapeArray(name: string, value: unknown[]): BqSchemaField | null {
  if (value.length === 0 || value.every((item) => item === null)) return null;
  if (value.some((item) => item === null)) return jsonSibling(name);

  if (value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    let fields: BqSchemaField[] = [];
    for (const item of value) {
      const itemFields = recordFields(item as Record<string, unknown>);
      const before = fields;
      fields = mergeFields(fields, itemFields);
      if (structurallyConflicts(before, itemFields)) return jsonSibling(name);
    }
    if (fields.length === 0) return jsonSibling(name);
    return { name, type: "RECORD", mode: "REPEATED", fields };
  }

  if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
    return { name, type: "STRING", mode: "REPEATED" };
  }
  return jsonSibling(name);
}

function jsonSibling(name: string): BqSchemaField {
  return { name: `${name}__json`, type: "STRING", mode: "NULLABLE" };
}

// ---- merging -------------------------------------------------------------- //

/** True if merging b into a would collide a scalar with a RECORD (structural). */
function structurallyConflicts(a: BqSchemaField[], b: BqSchemaField[]): boolean {
  const byName = new Map(a.map((f) => [f.name.toLowerCase(), f]));
  for (const f of b) {
    const existing = byName.get(f.name.toLowerCase());
    if (existing && (existing.type === "RECORD") !== (f.type === "RECORD")) return true;
  }
  return false;
}

/**
 * Union two field lists by (case-insensitive) name. On a type/structure
 * conflict, prefer the more specific shape (RECORD over scalar), recursing into
 * RECORDs — modelling "Axel will materialize a RECORD once it sees an object".
 */
function mergeFields(a: BqSchemaField[], b: BqSchemaField[], typed = false): BqSchemaField[] {
  const out: BqSchemaField[] = [];
  const index = new Map<string, number>();
  for (const f of a) {
    index.set(f.name.toLowerCase(), out.length);
    out.push(cloneField(f));
  }
  for (const f of b) {
    const key = f.name.toLowerCase();
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push(cloneField(f));
      continue;
    }
    out[at] = mergeField(out[at]!, f, typed);
  }
  return out;
}

function mergeField(a: BqSchemaField, b: BqSchemaField, typed = false): BqSchemaField {
  if (a.type === "RECORD" && b.type === "RECORD") {
    return { ...a, mode: a.mode === "REPEATED" || b.mode === "REPEATED" ? "REPEATED" : a.mode, fields: mergeFields(a.fields ?? [], b.fields ?? [], typed) };
  }
  // RECORD is more specific than a scalar leaf.
  if (a.type === "RECORD") return a;
  if (b.type === "RECORD") return b;
  // Both scalar. STRING modes keep `a` (every leaf is already STRING); typed
  // mode widens the two observed types toward a common one (INT64+FLOAT64 →
  // FLOAT64, anything else mismatched → STRING).
  return {
    ...a,
    type: typed ? widenBqScalar(a.type, b.type) : a.type,
    mode: a.mode === "REPEATED" || b.mode === "REPEATED" ? "REPEATED" : a.mode,
  };
}

function cloneField(f: BqSchemaField): BqSchemaField {
  return f.type === "RECORD" ? { ...f, fields: (f.fields ?? []).map(cloneField) } : { ...f };
}

// ---- delivered-row preview ------------------------------------------------ //

/**
 * The actual row Axel would insert for one event body + write mode — the VALUE
 * side of the connector's `buildRow` (the rest of this module models the TYPE
 * side). Reuses the same shaping helpers as expectedBigQuerySchema, so the
 * previewed row's keys and the previewed schema's field names always agree.
 *
 * Returns null when the body can't be shaped for the mode (the connector would
 * dead-letter it — e.g. a non-object body in columns/nested_records mode).
 * Best-effort for pathological field-name collisions, which the connector
 * dead-letters but this preview does not attempt to reproduce.
 */
export function bigQueryRowForEvent(
  body: unknown,
  mode: BigQueryWriteMode,
  payloadColumn = "payload",
): Record<string, unknown> | null {
  if (mode === "json_column") {
    // Connector normalizes through JSON; the sampled body is already parsed.
    return { [payloadColumn || "payload"]: JSON.stringify(body) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (mode === "columns") return flattenRowForColumns(body as Record<string, unknown>);
  // nested_records stringifies scalar leaves; typed_records keeps native types.
  return shapeRecordValue(body as Record<string, unknown>, mode === "typed_records").json;
}

/** Mirror of the connector's flattenForColumns — every leaf a STRING column. */
function flattenRowForColumns(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [rawKey, v] of Object.entries(node)) {
      let seg = rawKey.replace(/[^A-Za-z0-9_]/g, "_");
      if (/^[0-9]/.test(seg)) seg = `_${seg}`;
      const key = prefix ? `${prefix}_${seg}` : seg;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) out[key] = JSON.stringify(v);
      else if (typeof v === "object") walk(v as Record<string, unknown>, key);
      else out[key] = String(v);
    }
  };
  walk(obj, "");
  return out;
}

type ShapedFieldValue = { value: unknown; field: BqSchemaField };

/**
 * Shape one object into both its inserted JSON and its schema. `typed` keeps
 * scalar leaves in their source JSON type (typed_records); otherwise every
 * scalar leaf is normalized to STRING (nested_records).
 */
function shapeRecordValue(
  obj: Record<string, unknown>,
  typed = false,
): { json: Record<string, unknown>; fields: BqSchemaField[] } {
  const json: Record<string, unknown> = {};
  let fields: BqSchemaField[] = [];
  for (const [rawName, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const shaped = shapeFieldValue(bigQueryFieldName(rawName), value, typed);
    if (!shaped) continue;
    json[shaped.field.name] = shaped.value;
    fields = mergeFields(fields, [shaped.field], typed);
  }
  return { json, fields };
}

/** VALUE-producing sibling of shapeValue/shapeArray (same branch decisions). */
function shapeFieldValue(name: string, value: unknown, typed: boolean): ShapedFieldValue | null {
  if (Array.isArray(value)) return shapeArrayValue(name, value, typed);
  if (value !== null && typeof value === "object") {
    const rec = shapeRecordValue(value as Record<string, unknown>, typed);
    if (rec.fields.length === 0) return null; // empty/all-null object → skip
    return { value: rec.json, field: { name, type: "RECORD", mode: "NULLABLE", fields: rec.fields } };
  }
  // Scalar leaf: STRING (normalized) or the native source type (typed).
  if (typed) return { value, field: { name, type: inferBqScalarType(value), mode: "NULLABLE" } };
  return { value: String(value), field: { name, type: "STRING", mode: "NULLABLE" } };
}

function shapeArrayValue(name: string, value: unknown[], typed: boolean): ShapedFieldValue | null {
  if (value.length === 0 || value.every((item) => item === null)) return null;
  if (value.some((item) => item === null)) return jsonSiblingValue(name, value);

  if (value.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
    const jsons: Record<string, unknown>[] = [];
    let fields: BqSchemaField[] = [];
    for (const item of value) {
      const rec = shapeRecordValue(item as Record<string, unknown>, typed);
      if (structurallyConflicts(fields, rec.fields)) return jsonSiblingValue(name, value);
      fields = mergeFields(fields, rec.fields, typed);
      jsons.push(rec.json);
    }
    if (fields.length === 0) return jsonSiblingValue(name, value);
    return { value: jsons, field: { name, type: "RECORD", mode: "REPEATED", fields } };
  }

  if (value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
    if (typed) {
      // Widen the element types to one BigQuery type; native values unless the
      // array is mixed enough to fall back to STRING.
      const elem = value.map(inferBqScalarType).reduce((a, b) => widenBqScalar(a, b));
      if (elem !== "STRING") return { value, field: { name, type: elem, mode: "REPEATED" } };
    }
    return { value: value.map((item) => String(item)), field: { name, type: "STRING", mode: "REPEATED" } };
  }
  return jsonSiblingValue(name, value);
}

function jsonSiblingValue(name: string, value: unknown): ShapedFieldValue {
  return { value: JSON.stringify(value), field: jsonSibling(name) };
}
