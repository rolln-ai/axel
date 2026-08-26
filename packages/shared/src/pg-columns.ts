/**
 * Dot-notation column expansion for Postgres destinations.
 *
 * Shared, PURE (no I/O, no Node-only APIs — safe in a Cloudflare Worker) so the
 * live edge connector (postgres.js, apps/delivery-edge) and the Node reference
 * connector (pg, apps/delivery-service) compute identical column names + types
 * from the same payload. The number-one failure mode of "auto-expand columns"
 * is the ALTER and the INSERT disagreeing on a name — so the name is computed
 * ONCE here and both statements iterate the same `PgColumn[]`.
 *
 * Behaviour (informed by Airbyte Typing&Deduping / Fivetran / Singer / ClickHouse):
 *   - Recurse plain objects to build dotted leaf keys (`{user:{email}}` →
 *     `"user.email"`). Arrays and primitives are LEAVES — arrays land as one
 *     jsonb column, never `tags.0`, `tags.1`.
 *   - Null/undefined leaves are skipped (you can't infer a type from null;
 *     wait for a non-null occurrence).
 *   - Keys are sanitized, never rejected: a key with spaces/hyphens/unicode
 *     becomes a safe column rather than dead-lettering the whole event.
 *   - Postgres truncates identifiers at 63 BYTES silently; we own that with a
 *     deterministic hash suffix derived from the FULL original path so two long
 *     sibling paths can't collide into one column.
 *   - Depth and total-column budgets guard the hard 1600-column limit and
 *     map-style `{<dynamic-id>: …}` payloads: anything past the budget spills
 *     losslessly into one jsonb `_extra` column.
 *   - The shell table owns `id` (bigserial PK) and `received_at`; an incoming
 *     field literally named one of those is remapped so it can't clobber them.
 *
 * Type inference is per-leaf and lossless (numeric, not float). Conflicts are
 * resolved by WIDENING the existing column toward a universal sink — never by
 * narrowing — via {@link widenPgType}; the connector applies the ALTER lazily.
 */

export type PgLeafType = "boolean" | "bigint" | "numeric" | "text" | "jsonb";

export interface PgColumn {
  /** Final, safe, ≤63-byte column name (may contain literal dots). */
  name: string;
  /** Inferred Postgres type for a NEW column. */
  type: PgLeafType;
  /** Raw JS value to insert (objects/arrays kept as-is for jsonb encoding). */
  value: unknown;
}

/** Columns the auto-created shell table reserves; incoming clashes are remapped. */
export const PG_RESERVED_COLUMNS = new Set(["id", "received_at"]);
/** Stop recursing past this nesting depth; deeper sub-objects land as jsonb. */
export const PG_MAX_DEPTH = 12;
/** Soft column budget well under Postgres's hard 1600; overflow spills to _extra. */
export const PG_MAX_COLUMNS = 500;
/** Single jsonb column that absorbs over-budget / over-depth leaves losslessly. */
export const PG_OVERFLOW_COLUMN = "_extra";
/** Postgres identifier limit is 63 BYTES (NAMEDATALEN-1), not characters. */
export const PG_IDENT_MAX_BYTES = 63;

const encoder = new TextEncoder();
const byteLen = (s: string): number => encoder.encode(s).length;

/** Tiny, dependency-free FNV-1a (32-bit) → 8 hex chars. Not crypto; just stable. */
export function fnv1a8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Per-leaf Postgres type. Null/undefined must be filtered out before this. */
export function inferPgType(value: unknown): PgLeafType {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "bigint" : "numeric";
  if (typeof value === "string") return "text";
  // arrays and objects-at-depth-cap
  return "jsonb";
}

/**
 * Monotonic widening lattice: boolean < bigint < numeric < text, with text as
 * the universal lossless sink for anything incompatible (incl. jsonb↔scalar).
 * One-directional — we never narrow back (matches Fivetran/Singer).
 */
const SCALAR_LATTICE: PgLeafType[] = ["boolean", "bigint", "numeric", "text"];
export function widenPgType(existing: PgLeafType, incoming: PgLeafType): PgLeafType {
  if (existing === incoming) return existing;
  const ei = SCALAR_LATTICE.indexOf(existing);
  const ii = SCALAR_LATTICE.indexOf(incoming);
  if (ei >= 0 && ii >= 0) return SCALAR_LATTICE[Math.max(ei, ii)]!;
  // jsonb on one side and a scalar on the other (or any other mismatch) → text.
  return "text";
}

/**
 * Coerce a JS value to the param shape a column of `type` expects. `json: true`
 * means the caller must JSON-encode and cast ::jsonb (postgres.js `client.json`
 * / node-pg `::jsonb`). Scalars pass through natively — never JSON-wrap a scalar
 * or it double-encodes into a quoted jsonb string.
 */
export function coercePgValue(value: unknown, type: PgLeafType): { json: boolean; value: unknown } {
  if (type === "jsonb") return { json: true, value };
  if (type === "text") {
    if (value !== null && typeof value === "object") return { json: false, value: JSON.stringify(value) };
    return { json: false, value: String(value) };
  }
  // boolean / bigint / numeric — send the native scalar.
  return { json: false, value };
}

/** Quote a column identifier (always quoted; dots are literal, not separators). */
export function quotePgIdent(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.]*$/.test(name)) {
    throw new Error(`unsafe column identifier: ${JSON.stringify(name).slice(0, 80)}`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Split a (possibly schema-qualified) table reference into its schema + table.
 * The dashboard table picker emits `schema.table` for non-public schemas (e.g.
 * `app.events`) and the bare table for `public`. Split on the FIRST dot only;
 * each part is validated separately by quotePgIdent downstream. No dot → public.
 */
export function splitPgTable(name: string): { schema: string; table: string } {
  const dot = name.indexOf(".");
  if (dot === -1) return { schema: "public", table: name };
  return { schema: name.slice(0, dot), table: name.slice(dot + 1) };
}

/**
 * Quote a (possibly schema-qualified) TABLE reference as "schema"."table". Each
 * part is quoted SEPARATELY: quoting the whole `app.events` as a single
 * identifier yields "app.events", which Postgres resolves as a literal table
 * name in the search_path — a 42P01 (relation does not exist) in jsonb_blob
 * mode, or a silently-wrong public table auto-created under dotted_columns. Use
 * this (not quotePgIdent) everywhere a table name is interpolated into raw SQL.
 */
export function quotePgTable(name: string): string {
  const { schema, table } = splitPgTable(name);
  return `${quotePgIdent(schema)}.${quotePgIdent(table)}`;
}

/** Normalize one path SEGMENT (a single JSON key) into safe identifier chars. */
function sanitizeSegment(key: string): string {
  let out = "";
  for (const ch of key) out += /[A-Za-z0-9_]/.test(ch) ? ch : "_";
  out = out.replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (out === "") out = "_";
  if (/^[0-9]/.test(out)) out = `_${out}`;
  return out;
}

/**
 * Final column name for a leaf path. Sanitizes each segment (keeping dots as the
 * structural separator), then enforces the 63-byte limit with a deterministic
 * hash of the ORIGINAL path so distinct long paths never silently merge.
 */
function normalizeColumnName(segments: string[]): string {
  const joined = segments.map(sanitizeSegment).join(".");
  if (byteLen(joined) <= PG_IDENT_MAX_BYTES) return joined;
  const hash = fnv1a8(segments.join("\u0000")); // raw path; NUL can't appear in keys
  let prefix = joined;
  // Leave room for "_" + 8 hex chars within 63 bytes.
  while (byteLen(prefix) > PG_IDENT_MAX_BYTES - 9) prefix = prefix.slice(0, -1);
  prefix = prefix.replace(/[._]+$/, "");
  return `${prefix || "col"}_${hash}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export interface FlattenOptions {
  maxDepth?: number;
  maxColumns?: number;
}

/**
 * Flatten a payload into the ordered set of columns to ensure + insert.
 *
 * Non-object / array / scalar top-level payloads are wrapped as `{ value: … }`
 * rather than thrown, so an unusual-but-valid event is never dead-lettered.
 */
export function flattenPayloadToColumns(payload: unknown, opts: FlattenOptions = {}): PgColumn[] {
  const maxDepth = opts.maxDepth ?? PG_MAX_DEPTH;
  const maxColumns = opts.maxColumns ?? PG_MAX_COLUMNS;

  const root: Record<string, unknown> = isPlainObject(payload) ? payload : { value: payload };

  // Collect leaves in document order, tracking the raw path for hashing/dedup.
  const leaves: Array<{ name: string; rawPath: string; value: unknown }> = [];
  const overflow: Record<string, unknown> = {};
  const usedNames = new Map<string, string>(); // finalName -> rawPath that owns it

  const claim = (proposed: string, rawPath: string): string => {
    let name = proposed;
    if (PG_RESERVED_COLUMNS.has(name) || name === PG_OVERFLOW_COLUMN) name = `${name}__field`;
    const owner = usedNames.get(name);
    if (owner !== undefined && owner !== rawPath) {
      // Distinct paths collided onto one name — disambiguate deterministically.
      const suffix = `_${fnv1a8(rawPath)}`;
      let base = name;
      while (byteLen(base + suffix) > PG_IDENT_MAX_BYTES) base = base.slice(0, -1);
      name = `${base.replace(/[._]+$/, "") || "col"}${suffix}`;
    }
    usedNames.set(name, rawPath);
    return name;
  };

  const visit = (obj: Record<string, unknown>, stack: string[], depth: number): void => {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue; // skip null leaves
      const segments = [...stack, key];
      if (isPlainObject(value) && depth < maxDepth && Object.keys(value).length > 0) {
        visit(value, segments, depth + 1);
        continue;
      }
      // Leaf: array, scalar, empty object, or object at the depth cap (→ jsonb).
      const rawPath = segments.join(".");
      if (leaves.length >= maxColumns) {
        overflow[rawPath] = value; // lossless spill
        continue;
      }
      leaves.push({ name: claim(normalizeColumnName(segments), rawPath), rawPath, value });
    }
  };

  visit(root, [], 0);

  const columns: PgColumn[] = leaves.map((l) => ({
    name: l.name,
    type: inferPgType(l.value),
    value: l.value,
  }));
  if (Object.keys(overflow).length > 0) {
    columns.push({ name: PG_OVERFLOW_COLUMN, type: "jsonb", value: overflow });
  }
  return columns;
}

/**
 * Map an information_schema.data_type to our leaf-type lattice for widening.
 * (Moved verbatim from the two connector copies — apps/delivery-service
 * connectors/postgres.ts and apps/delivery-edge — so both drivers classify
 * live columns identically.)
 */
export function mapInfoSchemaType(dataType: string): PgLeafType {
  switch (dataType) {
    case "boolean":
      return "boolean";
    case "smallint":
    case "integer":
    case "bigint":
      return "bigint";
    case "numeric":
    case "real":
    case "double precision":
      return "numeric";
    case "json":
    case "jsonb":
      return "jsonb";
    default:
      return "text"; // text, character varying, timestamptz, uuid, …
  }
}

/**
 * How jsonb-typed insert params must be encoded for the caller's driver:
 *   - "stringified" — node-pg (apps/delivery-service): pass an explicit JSON
 *     string with the `$n::jsonb` cast; node-pg does not reliably encode a
 *     plain object to jsonb otherwise.
 *   - "raw" — postgres.js (apps/delivery-edge): pass the RAW object/array with
 *     the `$n::jsonb` cast; postgres.js serialises it exactly once, and a
 *     pre-stringified value would double-encode into a quoted jsonb string
 *     (verified empirically).
 */
export type PgJsonbParamEncoding = "stringified" | "raw";

export interface DottedInsertPlan {
  /** Flattened leaf columns, in insert order. */
  columns: PgColumn[];
  /** Brand-new columns to ADD (with their inferred types). */
  adds: Array<{ name: string; type: PgLeafType }>;
  /** Existing columns whose type must WIDEN for this event's values. */
  widens: Array<{ name: string; type: PgLeafType }>;
  /** name → effective column type after adds/widens are applied. */
  effective: Map<string, PgLeafType>;
  /** Single `ALTER TABLE … ADD COLUMN IF NOT EXISTS …` covering every add
   *  (one statement so concurrent workers don't serialize on N ALTERs;
   *  nullable, no default → metadata-only), or null when nothing to add. */
  addColumnsSql: string | null;
  /** One `ALTER TABLE … ALTER COLUMN … TYPE … USING …` per widen, in order. */
  widenColumnSql: string[];
  /** Parameterised INSERT over all flattened columns (`$n::jsonb` casts on
   *  jsonb leaves). */
  insertSql: string;
  /** Params matching `insertSql`, encoded per {@link PgJsonbParamEncoding}. */
  insertParams: unknown[];
}

/**
 * Plan a dotted-columns delivery: flatten the payload, diff against the live
 * column set, and emit the exact ALTER/INSERT SQL + params. Pure — the caller
 * owns execution, the (connStr, table) schema cache, the shell-table CREATE,
 * and the 42703 stale-cache retry (see {@link planColumnRepair}).
 *
 * Returns null when the payload flattens to zero columns (empty payload —
 * nothing to insert).
 */
export function planDottedColumnInsert(
  table: string,
  payload: unknown,
  existingTypes: ReadonlyMap<string, PgLeafType>,
  opts: { jsonbParams: PgJsonbParamEncoding },
): DottedInsertPlan | null {
  const columns = flattenPayloadToColumns(payload);
  if (columns.length === 0) return null;

  // New columns get their inferred type; existing columns WIDEN if this
  // event's value type conflicts with the stored type (boolean < bigint <
  // numeric < text, jsonb↔scalar → text) — never narrow.
  const adds: Array<{ name: string; type: PgLeafType }> = [];
  const widens: Array<{ name: string; type: PgLeafType }> = [];
  const effective = new Map<string, PgLeafType>();
  for (const c of columns) {
    const existing = existingTypes.get(c.name);
    if (existing === undefined) {
      adds.push({ name: c.name, type: c.type });
      effective.set(c.name, c.type);
    } else {
      const widened = widenPgType(existing, c.type);
      if (widened !== existing) widens.push({ name: c.name, type: widened });
      effective.set(c.name, widened);
    }
  }

  const addColumnsSql =
    adds.length > 0
      ? `ALTER TABLE ${quotePgTable(table)} ${adds
          .map((a) => `ADD COLUMN IF NOT EXISTS ${quotePgIdent(a.name)} ${a.type}`)
          .join(", ")}`
      : null;
  const widenColumnSql = widens.map(
    (w) =>
      `ALTER TABLE ${quotePgTable(table)} ALTER COLUMN ${quotePgIdent(w.name)} TYPE ${w.type} USING ${quotePgIdent(w.name)}::${w.type}`,
  );

  const names = columns.map((c) => quotePgIdent(c.name)).join(", ");
  const placeholders: string[] = [];
  const insertParams: unknown[] = [];
  columns.forEach((c, i) => {
    const type = effective.get(c.name)!;
    const { json, value } = coercePgValue(c.value, type);
    placeholders.push(json ? `$${i + 1}::jsonb` : `$${i + 1}`);
    insertParams.push(json && opts.jsonbParams === "stringified" ? JSON.stringify(value) : value);
  });
  const insertSql = `INSERT INTO ${quotePgTable(table)} (${names}) VALUES (${placeholders.join(", ")})`;

  return { columns, adds, widens, effective, addColumnsSql, widenColumnSql, insertSql, insertParams };
}

/**
 * Stale-cache repair for the 42703 (undefined_column) retry path: after the
 * caller refreshes the live column set, compute the ALTER that re-adds
 * whatever the INSERT still needs (a column dropped/renamed externally).
 * `added` carries the types the caller should write back into its cache.
 * Returns addColumnsSql null when the fresh schema already has every column
 * (the caller just re-runs the INSERT).
 */
export function planColumnRepair(
  table: string,
  plan: DottedInsertPlan,
  freshTypes: ReadonlyMap<string, PgLeafType>,
): { addColumnsSql: string | null; added: Array<{ name: string; type: PgLeafType }> } {
  const added = plan.columns
    .filter((c) => !freshTypes.has(c.name))
    .map((c) => ({ name: c.name, type: plan.effective.get(c.name) ?? c.type }));
  const addColumnsSql =
    added.length > 0
      ? `ALTER TABLE ${quotePgTable(table)} ${added
          .map((a) => `ADD COLUMN IF NOT EXISTS ${quotePgIdent(a.name)} ${a.type}`)
          .join(", ")}`
      : null;
  return { addColumnsSql, added };
}
