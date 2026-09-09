import { createSign } from "node:crypto";
import type { Connector, DeliveryContext } from "@axel/connectors";
import { bigQueryRowForEvent, compareBigQuerySchemas, expectedBigQuerySchema } from "@axel/shared";
import type {
  Destination,
  DeliveryAttempt,
  BigQueryBinding,
  BqSchemaField,
  BqCompatIssue,
} from "@axel/shared";

/**
 * Google BigQuery destination connector.
 *
 * Streams each event into a table via the legacy streaming REST endpoint
 * `tabledata.insertAll`. One HTTP POST per event, one row per POST. The row's
 * `insertId` carries the Axel event id so BigQuery's streaming buffer does
 * best-effort dedup on top of the queue-layer delivery_idempotency table.
 *
 * Three row shapes, chosen per route via the binding:
 *
 *   - `json_column` (default): the raw body lands as a string in a single
 *     column (`payload_column`, default "payload"). Nothing about the event's
 *     internal shape has to match the table — robust for messy/variable
 *     webhook bodies. The customer flattens downstream with SQL.
 *
 *   - `columns`: the parsed JSON body IS the row, so its top-level keys map
 *     onto flattened, underscore-joined STRING columns. This is the legacy
 *     flattened-warehouse pattern.
 *
 *   - `nested_records`: the parsed JSON body IS the row and its object
 *     hierarchy is retained as BigQuery RECORD fields while scalar leaves are
 *     normalized to STRING when provider field types drift. Compatible object
 *     arrays become REPEATED RECORDs and non-null primitive arrays become
 *     REPEATED STRINGs. Arrays without one safe shape use a lossless sibling
 *     `<field>__json` STRING.
 *     This mirrors Stitch's nested-table shape without brittle scalar types.
 *
 * Missing tables are created from the first event. Existing schemas stay
 * fixed unless the binding explicitly sets schema_evolution: add_columns.
 * Even adding a nullable nested field can break downstream STRUCT/UNION
 * queries. With the default manual policy, incompatible events dead-letter
 * for schema review and replay; unknown fields are never discarded.
 * Table creation and opted-in additions need the service
 * account to hold table create/update (BigQuery Data Editor), which is why we
 * request the broad `bigquery` scope. If those permissions are absent, the
 * DDL attempt fails and we fall back to reporting the original insert error —
 * so a locked-down, pre-provisioned setup still delivers into an existing
 * table without ever attempting DDL to succeed.
 *
 * Auth: a Google service account. Unlike Databricks' static bearer token we
 * mint a short-lived OAuth access token first — sign an RS256 JWT with the
 * service account's private key and exchange it at the token endpoint. Tokens
 * are cached per service account until just before expiry. This RSA-SHA256
 * signing is why BigQuery is a native-runtime (Node) destination.
 */

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
  project_id?: string;
}

interface BigQueryConfig {
  /** GCP project that owns the route's target dataset. May differ from the SA's own project. */
  project_id: string;
  /** Compatibility fallback for rows created before datasets moved to route bindings. */
  dataset?: string;
  table?: string;
  payload_column?: string;
  /** Merged in from destination_credentials at delivery time. */
  service_account_json?: string;
}

// BigQuery + Google endpoints are fixed hosts, so there is no user-supplied
// destination host to SSRF-guard (unlike the Databricks/Postgres connectors).
const BIGQUERY_API_ROOT = "https://bigquery.googleapis.com/bigquery/v2";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
// Broad scope so the same token can insert rows AND create/patch the table
// (best-effort schema management). Actual capability is still gated by the
// service account's IAM role.
const BIGQUERY_SCOPE = "https://www.googleapis.com/auth/bigquery";

const DEFAULT_TIMEOUT_MS = 30_000;
const DDL_TIMEOUT_MS = 15_000;
const TOKEN_TIMEOUT_MS = 10_000;
const SCHEMA_PATCH_MAX_ATTEMPTS = 3;
/** Immediate retry, then two short waits; queue-level retry handles longer lag. */
const SCHEMA_PROPAGATION_BACKOFF_MS = [0, 100, 300] as const;
/** Re-mint a cached token this many ms before its real expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

const TRANSIENT_ERROR_PATTERNS = [/econnreset/i, /etimedout/i, /socket hang up/i, /fetch failed/i];

/** Retryable per-row `insertErrors[].reason` values from insertAll. */
const RETRYABLE_ROW_REASONS = new Set(["backendError", "timeout", "internalError"]);

// Column names we're willing to auto-create: BigQuery standard column names
// (letter/underscore start, letters/digits/underscores, ≤300 chars). Invalid
// keys fail loudly at insertAll rather than being silently discarded.
const VALID_BQ_COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/;

type BigQueryMode = "json_column" | "columns" | "nested_records" | "typed_records";

/** Omitted or unknown runtime values retain the historical default. */
function bigQueryModeOf(binding: BigQueryBinding): BigQueryMode {
  const mode = (binding as BigQueryBinding & { mode?: BigQueryMode }).mode;
  if (mode === "columns" || mode === "nested_records" || mode === "typed_records") return mode;
  return "json_column";
}

/** Map @axel/shared schema fields to the connector's BqField for DDL. */
function toBqFields(fields: BqSchemaField[]): BqField[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    mode: f.mode,
    ...(f.fields ? { fields: toBqFields(f.fields) } : {}),
  }));
}

/**
 * JavaScript exposes every JSON number as the same double-precision `number`
 * type. An integer-looking first event therefore cannot prove that a field
 * will stay integral. Creating an INT64 column from that single sample makes
 * the table reject the first later fractional value, even though FLOAT64 can
 * represent both shapes.
 *
 * Keep the per-row schema exact for diagnostics, but use FLOAT64 for inferred
 * numeric columns that Axel creates or adds in typed_records mode. Existing
 * INT64 columns continue accepting integral rows unchanged; a real fractional
 * mismatch still gets the precise repair guidance below.
 */
function managedTypedRecordsSchema(fields: BqField[]): BqField[] {
  return fields.map((field) => ({
    ...field,
    type: field.type === "INT64" ? "FLOAT64" : field.type,
    ...(field.fields ? { fields: managedTypedRecordsSchema(field.fields) } : {}),
  }));
}

function attemptOf(
  context: DeliveryContext | undefined,
  destination: Destination,
  status: DeliveryAttempt["status"],
  response: unknown,
  startedAt: number,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: context?.eventId ?? "unknown",
    destination_id: destination.destination_id,
    status,
    response,
    latency_ms: Date.now() - startedAt,
    created_at: new Date().toISOString(),
  };
}

function resolveBigQueryBinding(
  binding: unknown,
  config: BigQueryConfig,
): BigQueryBinding | null {
  if (
    binding &&
    typeof binding === "object" &&
    "table" in binding &&
    typeof (binding as BigQueryBinding).table === "string"
  ) {
    return binding as BigQueryBinding;
  }
  if (config.dataset && config.table) {
    return {
      dataset: config.dataset,
      table: config.table,
      ...(config.payload_column !== undefined ? { payload_column: config.payload_column } : {}),
    };
  }
  return null;
}

// -------------------------------------------------------------------------
// Service-account auth: JWT sign -> OAuth token, cached per SA.
// -------------------------------------------------------------------------

interface CachedToken {
  token: string;
  /** Absolute epoch-ms at which we should stop using this token. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const diagnosticSchemaCache = new Map<string, { expiresAt: number; fields: BqField[] }>();
const DIAGNOSTIC_SCHEMA_TTL_MS = 60_000;

/** Exposed for tests — drop cached tokens (e.g. after a 401 forces a re-mint). */
export function clearBigQueryTokenCache(): void {
  tokenCache.clear();
  diagnosticSchemaCache.clear();
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

class TokenError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

function parseServiceAccount(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TokenError("service_account_json is not valid JSON", false);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new TokenError("service_account_json is not an object", false);
  }
  const sa = parsed as Partial<ServiceAccountKey>;
  if (typeof sa.client_email !== "string" || !sa.client_email) {
    throw new TokenError("service_account_json missing client_email", false);
  }
  if (typeof sa.private_key !== "string" || !sa.private_key.includes("PRIVATE KEY")) {
    throw new TokenError("service_account_json missing a usable private_key", false);
  }
  return {
    client_email: sa.client_email,
    private_key: sa.private_key,
    // Google service-account token exchange always uses this fixed endpoint.
    // Never trust the credential's token_uri as a fetch target.
    token_uri: DEFAULT_TOKEN_URI,
    ...(typeof sa.project_id === "string" ? { project_id: sa.project_id } : {}),
  };
}

function invalidateToken(sa: ServiceAccountKey): void {
  tokenCache.delete(sa.client_email);
}

async function getAccessToken(sa: ServiceAccountKey): Promise<string> {
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: BIGQUERY_SCOPE,
      aud: DEFAULT_TOKEN_URI,
      iat: nowSec,
      exp: nowSec + 3600,
    }),
  );
  const signingInput = `${header}.${claims}`;

  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(signingInput).sign(sa.private_key, "base64url");
  } catch {
    // A malformed/unsupported key is a permanent config problem.
    throw new TokenError("jwt_sign_failed", false);
  }
  const assertion = `${signingInput}.${signature}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(DEFAULT_TOKEN_URI, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transient = TRANSIENT_ERROR_PATTERNS.some((re) => re.test(message))
      || (err instanceof Error && err.name === "AbortError");
    throw new TokenError("token_endpoint_unreachable", transient);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 400/401 from the token endpoint = bad key/clock/grant → permanent.
    // 429/5xx → transient.
    const retryable = res.status === 429 || res.status >= 500;
    await res.body?.cancel().catch(() => undefined);
    throw new TokenError(`token_exchange_${res.status}`, retryable);
  }
  const text = await res.text();
  let body: { access_token?: string; expires_in?: number };
  try {
    body = JSON.parse(text) as { access_token?: string; expires_in?: number };
  } catch {
    throw new TokenError("token_endpoint_returned_non_json", true);
  }
  if (!body.access_token) {
    throw new TokenError("token_endpoint_missing_access_token", true);
  }
  const ttlMs = (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000;
  tokenCache.set(sa.client_email, {
    token: body.access_token,
    expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_EXPIRY_MARGIN_MS),
  });
  return body.access_token;
}

// -------------------------------------------------------------------------
// Row shaping
// -------------------------------------------------------------------------

interface InsertRow {
  insertId: string;
  json: Record<string, unknown>;
}

type BqFieldMode = "NULLABLE" | "REPEATED" | "REQUIRED";

interface BqField {
  name: string;
  type: string;
  mode?: BqFieldMode;
  fields?: BqField[];
  /** Preserve table-field metadata we don't own during schema PATCHes. */
  [key: string]: unknown;
}

interface NestedRecordShape {
  json: Record<string, unknown>;
  fields: BqField[];
  nameUsage: NestedNameUsage;
}

interface NestedNameUse {
  rawName: string;
  fieldName: string;
}

interface NestedNameUsage {
  /** Every explicit JSON key at this RECORD level, including skipped values. */
  baseNames: Map<string, NestedNameUse>;
  /** Synthetic `<field>__json` names emitted at this RECORD level. */
  syntheticJsonNames: Map<string, NestedNameUse>;
  /** Name usage below child RECORD fields, keyed by normalized field name. */
  recordChildren: Map<string, NestedNameUsage>;
}

type NestedRecordResult = NestedRecordShape | { dead: string };
type NestedFieldResult =
  | { value: unknown; field: BqField; recordNameUsage?: NestedNameUsage }
  | { skip: true }
  | { dead: string };

/**
 * Recursively flatten a nested object into a single-level map of
 * underscore-joined column names → STRING values. This makes `columns` mode
 * tolerant of arbitrarily nested payloads: BigQuery streaming can't map a
 * nested object onto a non-RECORD column ("field X is not a record"), so we
 * flatten instead. Every leaf is stringified — scalars via String(),
 * arrays / any leftover objects via JSON — so a field that drifts type across
 * events, as some newsletter providers do, can never break the insert. Nulls
 * are skipped (the column materializes once a non-null value appears). Keys are
 * sanitized to valid BigQuery column names; a segment starting with a digit is
 * prefixed with "_".
 *
 * e.g. {event:"x", data:{subscriber:{email:"a@b"}, items:[1,2]}}
 *   → {event:"x", data_subscriber_email:"a@b", data_items:"[1,2]"}
 */
function flattenForColumns(obj: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (node: Record<string, unknown>, prefix: string): void => {
    for (const [rawKey, v] of Object.entries(node)) {
      let seg = rawKey.replace(/[^A-Za-z0-9_]/g, "_");
      if (/^[0-9]/.test(seg)) seg = `_${seg}`;
      const key = prefix ? `${prefix}_${seg}` : seg;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        out[key] = JSON.stringify(v);
      } else if (typeof v === "object") {
        walk(v as Record<string, unknown>, key);
      } else {
        out[key] = String(v);
      }
    }
  };
  walk(obj, "");
  return out;
}

/** Make one nested field segment legal without removing its hierarchy. */
function nestedFieldName(rawKey: string): string {
  let name = rawKey.replace(/[^A-Za-z0-9_]/g, "_");
  if (name.length === 0) name = "_";
  if (/^[0-9]/.test(name)) name = `_${name}`;
  return name.slice(0, 300);
}

const JSON_SIBLING_SUFFIX = "__json";

/** Keep the reserved suffix inside BigQuery's 300-character field limit. */
function jsonSiblingFieldName(name: string): string {
  return `${name.slice(0, 300 - JSON_SIBLING_SUFFIX.length)}${JSON_SIBLING_SUFFIX}`;
}

function jsonSiblingFallback(name: string, value: unknown): NestedFieldResult {
  const sibling = jsonSiblingFieldName(name);
  return {
    value: JSON.stringify(value),
    field: { name: sibling, type: "STRING", mode: "NULLABLE" },
  };
}

function emptyNestedNameUsage(): NestedNameUsage {
  return {
    baseNames: new Map(),
    syntheticJsonNames: new Map(),
    recordChildren: new Map(),
  };
}

/**
 * Combine name provenance across members of a repeated RECORD. Besides
 * ordinary sanitized-name collisions, this catches an explicit `foo__json`
 * in one member colliding with the reserved fallback for `foo` in another.
 */
function mergeNestedNameUsages(
  left: NestedNameUsage,
  right: NestedNameUsage,
): NestedNameUsage | { dead: string } {
  const merged: NestedNameUsage = {
    baseNames: new Map(left.baseNames),
    syntheticJsonNames: new Map(left.syntheticJsonNames),
    recordChildren: new Map(left.recordChildren),
  };

  for (const [key, incoming] of right.baseNames) {
    const current = merged.baseNames.get(key);
    if (current && current.rawName !== incoming.rawName) {
      return {
        dead: `nested_records field-name collision: ${JSON.stringify(current.rawName)} and ${JSON.stringify(incoming.rawName)} both map to ${JSON.stringify(incoming.fieldName)}`,
      };
    }
    merged.baseNames.set(key, incoming);
  }

  for (const [key, incoming] of right.syntheticJsonNames) {
    const current = merged.syntheticJsonNames.get(key);
    if (current && current.rawName !== incoming.rawName) {
      return {
        dead: `nested_records JSON sibling collision: ${JSON.stringify(current.rawName)} and ${JSON.stringify(incoming.rawName)} both reserve ${JSON.stringify(incoming.fieldName)}`,
      };
    }
    merged.syntheticJsonNames.set(key, incoming);
  }

  for (const [key, synthetic] of merged.syntheticJsonNames) {
    const explicit = merged.baseNames.get(key);
    if (explicit) {
      return {
        dead: `nested_records JSON sibling collision: ${JSON.stringify(synthetic.rawName)} needs reserved field ${JSON.stringify(synthetic.fieldName)}, but explicit key ${JSON.stringify(explicit.rawName)} maps there`,
      };
    }
  }

  for (const [key, incoming] of right.recordChildren) {
    const current = merged.recordChildren.get(key);
    if (!current) {
      merged.recordChildren.set(key, incoming);
      continue;
    }
    const child = mergeNestedNameUsages(current, incoming);
    if ("dead" in child) return child;
    merged.recordChildren.set(key, child);
  }

  return merged;
}

/**
 * Merge schemas inferred from members of the same repeated-record value.
 * Scalar leaves have already been normalized to STRING, so a conflict here
 * means the members disagree structurally (RECORD versus scalar, or repeated
 * versus singular). Such arrays use the lossless JSON sibling fallback.
 */
function mergeCompatibleGeneratedFields(
  left: BqField[],
  right: BqField[],
): { fields: BqField[]; compatible: boolean } {
  const merged = left.map((field) => ({
    ...field,
    ...(field.fields ? { fields: field.fields.map((child) => ({ ...child })) } : {}),
  }));

  for (const incoming of right) {
    const index = merged.findIndex(
      (field) => field.name.toLowerCase() === incoming.name.toLowerCase(),
    );
    if (index === -1) {
      merged.push(incoming);
      continue;
    }

    const current = merged[index]!;
    const currentMode = current.mode ?? "NULLABLE";
    const incomingMode = incoming.mode ?? "NULLABLE";
    if (currentMode !== incomingMode) return { fields: left, compatible: false };

    if (current.type === "RECORD" && incoming.type === "RECORD") {
      const nested = mergeCompatibleGeneratedFields(
        current.fields ?? [],
        incoming.fields ?? [],
      );
      if (!nested.compatible) return { fields: left, compatible: false };
      merged[index] = { ...current, fields: nested.fields };
      continue;
    }

    if (current.type === incoming.type) continue;
    return { fields: left, compatible: false };
  }

  return { fields: merged, compatible: true };
}

function isJsonPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function shapeNestedField(name: string, value: unknown): NestedFieldResult {
  if (Array.isArray(value)) {
    // Empty/all-null arrays carry no usable type information. Skip them so a
    // later populated value can claim the base field with its real shape.
    if (value.length === 0 || value.every((item) => item === null)) return { skip: true };

    // A partially-null repeated value cannot be represented losslessly by
    // BigQuery REPEATED fields. Store it beside the reserved base name.
    if (value.some((item) => item === null)) return jsonSiblingFallback(name, value);

    if (value.every((item) => typeof item === "object" && !Array.isArray(item))) {
      const records: NestedRecordShape[] = [];
      let fields: BqField[] = [];
      let nameUsage = emptyNestedNameUsage();
      for (const item of value) {
        const shaped = shapeNestedRecord(item as Record<string, unknown>);
        if ("dead" in shaped) return shaped;
        records.push(shaped);
        const combined = mergeCompatibleGeneratedFields(fields, shaped.fields);
        if (!combined.compatible) return jsonSiblingFallback(name, value);
        fields = combined.fields;
        const combinedNameUsage = mergeNestedNameUsages(nameUsage, shaped.nameUsage);
        if ("dead" in combinedNameUsage) return combinedNameUsage;
        nameUsage = combinedNameUsage;
      }
      // A RECORD with no child schema is not useful/portable in table DDL.
      if (fields.length === 0) return jsonSiblingFallback(name, value);
      return {
        value: records.map((record) => record.json),
        field: { name, type: "RECORD", mode: "REPEATED", fields },
        recordNameUsage: nameUsage,
      };
    }

    // Primitive-family drift is common in custom provider fields. A mixed
    // non-null primitive array is still safe once every member is a STRING.
    if (value.every(isJsonPrimitive)) {
      return {
        value: value.map((item) => String(item)),
        field: { name, type: "STRING", mode: "REPEATED" },
      };
    }

    // Nested arrays and object/scalar mixtures have no legal single BigQuery
    // repeated shape. Preserve their exact JSON under the reserved sibling.
    return jsonSiblingFallback(name, value);
  }

  if (value !== null && typeof value === "object") {
    const shaped = shapeNestedRecord(value as Record<string, unknown>);
    if ("dead" in shaped) return shaped;
    // Empty/all-null objects cannot form a valid RECORD schema. Treat them as
    // untyped, just like a direct null field, so a later populated object can
    // materialize the real RECORD shape.
    if (shaped.fields.length === 0) return { skip: true };
    return {
      value: shaped.json,
      field: { name, type: "RECORD", mode: "NULLABLE", fields: shaped.fields },
      recordNameUsage: shaped.nameUsage,
    };
  }

  return {
    value: String(value),
    field: { name, type: "STRING", mode: "NULLABLE" },
  };
}

/** Shape a JSON object and infer the exact nested schema for that shaped row. */
function shapeNestedRecord(obj: Record<string, unknown>): NestedRecordResult {
  const entries: Array<[string, unknown]> = [];
  const fields: BqField[] = [];
  const nameUsage = emptyNestedNameUsage();

  // Reserve every explicit key before inspecting its value. That lets us
  // detect `foo` -> `foo__json` collisions even when the explicit sibling's
  // current value would otherwise be skipped.
  for (const rawName of Object.keys(obj)) {
    const fieldName = nestedFieldName(rawName);
    const collisionKey = fieldName.toLowerCase();
    const previous = nameUsage.baseNames.get(collisionKey);
    if (previous && previous.rawName !== rawName) {
      return {
        dead: `nested_records field-name collision: ${JSON.stringify(previous.rawName)} and ${JSON.stringify(rawName)} both map to ${JSON.stringify(fieldName)}`,
      };
    }
    nameUsage.baseNames.set(collisionKey, { rawName, fieldName });
  }

  for (const [rawName, value] of Object.entries(obj)) {
    // A null-only field has no stable type. Omitting it lets a later non-null
    // event materialize the field through recursive schema evolution.
    if (value === null || value === undefined) continue;

    const name = nestedFieldName(rawName);
    const shaped = shapeNestedField(name, value);
    if ("dead" in shaped) return shaped;
    if ("skip" in shaped) continue;

    const outputName = shaped.field.name;
    const outputKey = outputName.toLowerCase();
    if (outputKey !== name.toLowerCase()) {
      const explicit = nameUsage.baseNames.get(outputKey);
      if (explicit) {
        return {
          dead: `nested_records JSON sibling collision: ${JSON.stringify(rawName)} needs reserved field ${JSON.stringify(outputName)}, but explicit key ${JSON.stringify(explicit.rawName)} maps there`,
        };
      }
      const previous = nameUsage.syntheticJsonNames.get(outputKey);
      if (previous && previous.rawName !== rawName) {
        return {
          dead: `nested_records JSON sibling collision: ${JSON.stringify(previous.rawName)} and ${JSON.stringify(rawName)} both reserve ${JSON.stringify(outputName)}`,
        };
      }
      nameUsage.syntheticJsonNames.set(outputKey, { rawName, fieldName: outputName });
    }
    if (shaped.recordNameUsage) {
      nameUsage.recordChildren.set(name.toLowerCase(), shaped.recordNameUsage);
    }

    entries.push([outputName, shaped.value]);
    fields.push(shaped.field);
  }

  return { json: Object.fromEntries(entries), fields, nameUsage };
}

/**
 * Build the insertAll row for this event + binding. Returns a `dead` reason
 * string when the body can't be shaped for the chosen mode (permanent).
 */
function buildRow(
  event: ArrayBuffer,
  binding: BigQueryBinding,
  eventId: string,
): { row: InsertRow; schemaFields?: BqField[] } | { dead: string } {
  const text = new TextDecoder().decode(event);
  const mode = bigQueryModeOf(binding);

  if (mode === "columns" || mode === "nested_records" || mode === "typed_records") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { dead: `${mode} mode requires a JSON object body; body is not JSON` };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { dead: `${mode} mode requires a JSON object body (got array/primitive)` };
    }
    if (mode === "typed_records") {
      // Reuse the @axel/shared shaper so the row + inferred schema match the
      // dashboard pre-flight preview exactly. Scalar leaves keep their source
      // JSON type (INT64/FLOAT64/BOOL/STRING); a type that drifts from an
      // existing column can't be widened (BigQuery constraint) and dead-letters.
      const json = bigQueryRowForEvent(parsed, "typed_records");
      if (json === null) {
        return { dead: "typed_records mode requires a JSON object body" };
      }
      return {
        row: { insertId: eventId, json },
        schemaFields: toBqFields(expectedBigQuerySchema([parsed], "typed_records")),
      };
    }
    if (mode === "nested_records") {
      const shaped = shapeNestedRecord(parsed as Record<string, unknown>);
      if ("dead" in shaped) return shaped;
      return {
        row: { insertId: eventId, json: shaped.json },
        schemaFields: shaped.fields,
      };
    }
    // Flatten nested objects into underscore-joined STRING columns so any
    // nesting depth / type drift maps cleanly onto BigQuery columns.
    return { row: { insertId: eventId, json: flattenForColumns(parsed as Record<string, unknown>) } };
  }

  // json_column (default): normalize through JSON when possible so non-UTF8
  // bytes don't poison the value; fall back to the raw text otherwise.
  let payloadString: string;
  try {
    payloadString = JSON.stringify(JSON.parse(text));
  } catch {
    payloadString = text;
  }
  const column = binding.payload_column ?? "payload";
  return { row: { insertId: eventId, json: { [column]: payloadString } } };
}

// -------------------------------------------------------------------------
// Schema management (best-effort auto-DDL)
// -------------------------------------------------------------------------

/** Infer a BigQuery column type for the legacy flat modes. Best-effort. */
function inferBqType(v: unknown): string {
  if (typeof v === "boolean") return "BOOL";
  if (typeof v === "number") return Number.isInteger(v) ? "INT64" : "FLOAT64";
  if (v !== null && typeof v === "object") return "JSON"; // object or array
  return "STRING"; // string / null / undefined
}

/** The columns we'd create a fresh table with, given the mode + first row. */
function schemaFieldsFor(
  mode: BigQueryMode,
  row: InsertRow,
  payloadColumn: string,
  nestedFields?: BqField[],
): BqField[] {
  if (mode === "nested_records" || mode === "typed_records") return nestedFields ?? [];
  if (mode === "columns") {
    return Object.entries(row.json)
      .filter(([k]) => VALID_BQ_COLUMN.test(k))
      .map(([k, v]) => ({ name: k, type: inferBqType(v), mode: "NULLABLE" as const }));
  }
  return [{ name: payloadColumn, type: "STRING", mode: "NULLABLE" }];
}

interface BqApiResponse {
  status: number;
  text: string;
}

type SchemaRepairOutcome = "ready" | "retry" | "failed" | "blocked";
type CreateTableOutcome = "created" | "exists" | "retry" | "failed";

function isRetryableDdlResponse(response: BqApiResponse): boolean {
  if (response.status === 408 || response.status === 429 || response.status >= 500) return true;
  return response.status === 403
    && /rateLimitExceeded|quotaExceeded|backendError/i.test(response.text);
}

async function bqApi(
  token: string,
  method: string,
  url: string,
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<BqApiResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DDL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

/** Create the table, distinguishing a concurrent creator from our own DDL. */
async function createTable(
  token: string,
  projectId: string,
  dataset: string,
  table: string,
  fields: BqField[],
): Promise<CreateTableOutcome> {
  if (fields.length === 0) return "failed";
  const url =
    `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}` +
    `/datasets/${encodeURIComponent(dataset)}/tables`;
  const response = await bqApi(token, "POST", url, {
    tableReference: { projectId, datasetId: dataset, tableId: table },
    schema: { fields },
  });
  if (response.status === 200 || response.status === 201) return "created";
  if (response.status === 409) return "exists";
  return isRetryableDdlResponse(response) ? "retry" : "failed";
}

/** Recursively add desired fields without changing or deleting table fields. */
function mergeSchemaFieldsForPatch(
  existing: BqField[],
  desired: BqField[],
): { fields: BqField[]; changed: boolean } {
  const fields = existing.map((field) => ({ ...field }));
  let changed = false;

  for (const incoming of desired) {
    const index = fields.findIndex(
      (field) => field.name.toLowerCase() === incoming.name.toLowerCase(),
    );
    if (index === -1) {
      fields.push(incoming);
      changed = true;
      continue;
    }

    const current = fields[index]!;
    const currentMode = current.mode ?? "NULLABLE";
    const incomingMode = incoming.mode ?? "NULLABLE";
    const bothRecords = current.type.toLocaleUpperCase() === "RECORD"
      && incoming.type.toLocaleUpperCase() === "RECORD";

    // BigQuery does not support changing a field's type or mode in this
    // additive PATCH. Recurse only through compatible RECORD containers.
    const bothRepeated = currentMode === "REPEATED" && incomingMode === "REPEATED";
    const bothSingular = currentMode !== "REPEATED" && incomingMode !== "REPEATED";
    if (!bothRecords || (!bothRepeated && !bothSingular)) continue;
    const nested = mergeSchemaFieldsForPatch(current.fields ?? [], incoming.fields ?? []);
    if (nested.changed) {
      fields[index] = { ...current, fields: nested.fields };
      changed = true;
    }
  }

  return { fields, changed };
}

/**
 * Add any top-level or nested fields missing from the table. Every PATCH uses
 * the ETag from its preceding GET. A 412 restarts GET/merge/PATCH so concurrent
 * adders are retained; if their winning schema already contains our desired
 * fields, the table is ready without another PATCH.
 */
async function patchTableAddColumns(
  token: string,
  projectId: string,
  dataset: string,
  table: string,
  desiredFields: BqField[],
  allowAdditions: boolean,
): Promise<SchemaRepairOutcome> {
  const url =
    `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}` +
    `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}`;

  for (let attempt = 0; attempt < SCHEMA_PATCH_MAX_ATTEMPTS; attempt += 1) {
    const got = await bqApi(token, "GET", url);
    if (got.status !== 200) {
      return got.status === 404 || isRetryableDdlResponse(got) ? "retry" : "failed";
    }
    const current = JSON.parse(got.text) as {
      etag?: string;
      schema?: { fields?: BqField[] };
    };
    const merged = mergeSchemaFieldsForPatch(current.schema?.fields ?? [], desiredFields);
    if (!merged.changed) return "ready";
    if (!allowAdditions) return "blocked";
    if (!current.etag) return "retry";

    const patched = await bqApi(
      token,
      "PATCH",
      url,
      { schema: { fields: merged.fields } },
      { "If-Match": current.etag },
    );
    if (patched.status === 200) return "ready";
    if (patched.status === 412) continue;
    return isRetryableDdlResponse(patched) ? "retry" : "failed";
  }

  return "retry";
}

const MISSING_SCHEMA_PATTERN = /no such field|not found: field|has no schema/i;

function isSchemaPropagationPending(response: BqApiResponse): boolean {
  return response.status === 404 || MISSING_SCHEMA_PATTERN.test(response.text);
}

function waitForSchemaPropagation(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/**
 * BigQuery can accept table/schema DDL before streaming metadata observes it.
 * Retry a few times locally, then let the queue's normal retry policy absorb
 * longer propagation windows rather than dead-lettering a valid row.
 */
async function retryInsertAfterSchemaRepair(
  insert: () => Promise<BqApiResponse>,
): Promise<{ response: BqApiResponse; propagationPending: boolean }> {
  let response!: BqApiResponse;
  for (const delayMs of SCHEMA_PROPAGATION_BACKOFF_MS) {
    if (delayMs > 0) await waitForSchemaPropagation(delayMs);
    response = await insert();
    if (!isSchemaPropagationPending(response)) {
      return { response, propagationPending: false };
    }
  }
  return { response, propagationPending: true };
}

// -------------------------------------------------------------------------
// Connector
// -------------------------------------------------------------------------

interface InsertAllResponse {
  insertErrors?: Array<{
    index?: number;
    errors?: Array<{ reason?: string; message?: string }>;
  }>;
}

function compatFields(fields: BqField[]): BqSchemaField[] {
  return fields.map((field) => ({
    name: field.name,
    type: field.type,
    mode: field.mode ?? "NULLABLE",
    ...(field.fields ? { fields: compatFields(field.fields) } : {}),
  }));
}

/**
 * BigQuery's insertAll error often reports only the bad value ("5.69") and
 * omits the field. On a permanent row error, read the declared table schema
 * once and diff it against the exact row shape so the dead letter names the
 * field and both types. This happens only on a terminal failure, never on the
 * hot success path.
 */
async function diagnoseSchemaMismatches(
  token: string,
  projectId: string,
  dataset: string,
  table: string,
  desired: BqField[],
): Promise<BqCompatIssue[]> {
  const cacheKey = `${projectId}.${dataset}.${table}`;
  const cached = diagnosticSchemaCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return compareBigQuerySchemas(compatFields(desired), compatFields(cached.fields)).conflicts;
  }
  const url =
    `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}` +
    `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(table)}`;
  const got = await bqApi(token, "GET", url);
  if (got.status !== 200) return [];
  const current = JSON.parse(got.text) as { schema?: { fields?: BqField[] } };
  const currentFields = current.schema?.fields ?? [];
  diagnosticSchemaCache.set(cacheKey, {
    expiresAt: Date.now() + DIAGNOSTIC_SCHEMA_TTL_MS,
    fields: currentFields,
  });
  return compareBigQuerySchemas(
    compatFields(desired),
    compatFields(currentFields),
  ).conflicts;
}

function actionableMismatchMessage(issue: BqCompatIssue): string {
  const lead = `BigQuery type mismatch at "${issue.path}": Axel sends ${issue.expected}, but the target column is ${issue.existing}. Retrying unchanged data will fail again.`;
  if (issue.kind === "mode_conflict") {
    if (issue.expected.startsWith("REPEATED ")) {
      return `${lead} Use a compatible table where "${issue.path}" is ${issue.expected}, or add a Collapse arrays to text step for "${issue.path}" if one STRING value is intentional.`;
    }
    return `${lead} Use a compatible non-repeated column, or adjust the route so "${issue.path}" is an array before delivery.`;
  }
  if (issue.existing.includes("INT64") && issue.expected.includes("FLOAT64")) {
    return `${lead} Change the target column to FLOAT64, or add a Convert field types step for "${issue.path}" and choose an explicit integer rounding rule.`;
  }
  if (issue.existing.includes("STRING")) {
    return `${lead} Change the target column to ${issue.expected.replace("REPEATED ", "")}, or convert "${issue.path}" to Text (STRING) before delivery.`;
  }
  return `${lead} Change the target column type, or convert "${issue.path}" in the route before delivery.`;
}

export function createBigQueryConnector(): Connector<BigQueryConfig> {
  return {
    type: "bigquery",
    async deliver(event, destination, context) {
      const startedAt = Date.now();
      const config = destination.config;

      if (!config.service_account_json) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "service_account_json missing — credential not merged into config" },
          startedAt,
        );
      }

      const projectId = String(config.project_id ?? "");
      // Datasets are letters/digits/underscores; TABLE names additionally allow
      // hyphens (BigQuery permits them, e.g. `data-temp`); project ids allow
      // dots/hyphens/colons (legacy domain-scoped ids). These are URL path
      // segments (encodeURIComponent'd) and JSON body values, not SQL — the
      // checks are defence-in-depth against malformed requests.
      if (!/^[A-Za-z0-9._:-]+$/.test(projectId)) {
        return attemptOf(context, destination, "dead", { error: `invalid project_id: ${projectId}` }, startedAt);
      }

      const binding = resolveBigQueryBinding(context?.binding, config);
      if (!binding) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "no table binding configured for this route/destination" },
          startedAt,
        );
      }
      const dataset = String(binding.dataset ?? config.dataset ?? "");
      if (!dataset) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "no dataset binding or default configured for this route/destination" },
          startedAt,
        );
      }
      if (!/^[A-Za-z0-9_]{1,1024}$/.test(dataset)) {
        return attemptOf(context, destination, "dead", { error: `invalid dataset: ${dataset}` }, startedAt);
      }
      if (!/^[A-Za-z0-9_-]{1,1024}$/.test(binding.table)) {
        return attemptOf(context, destination, "dead", { error: `invalid table: ${binding.table}` }, startedAt);
      }

      const mode = bigQueryModeOf(binding);
      const payloadColumn = binding.payload_column ?? "payload";
      const built = buildRow(event, binding, context?.eventId ?? "unknown");
      if ("dead" in built) {
        return attemptOf(context, destination, "dead", { error: built.dead }, startedAt);
      }
      const desiredSchemaFields = schemaFieldsFor(
        mode,
        built.row,
        payloadColumn,
        built.schemaFields,
      );
      const managedSchemaFields = mode === "typed_records"
        ? managedTypedRecordsSchema(desiredSchemaFields)
        : desiredSchemaFields;

      // Mint (or reuse) an access token for the service account.
      let sa: ServiceAccountKey;
      try {
        sa = parseServiceAccount(config.service_account_json);
      } catch (err) {
        return attemptOf(context, destination, "dead", { error: err instanceof Error ? err.message : String(err) }, startedAt);
      }
      let accessToken: string;
      try {
        accessToken = await getAccessToken(sa);
      } catch (err) {
        const retryable = err instanceof TokenError ? err.retryable : true;
        return attemptOf(
          context,
          destination,
          retryable ? "retry" : "dead",
          { error: err instanceof Error ? err.message : String(err) },
          startedAt,
        );
      }

      const url =
        `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}` +
        `/datasets/${encodeURIComponent(dataset)}` +
        `/tables/${encodeURIComponent(binding.table)}/insertAll`;

      const requestBody = {
        kind: "bigquery#tableDataInsertAllRequest",
        skipInvalidRows: false,
        // Unknown columns must surface as insertErrors so the schema-repair
        // branch can add them. Ignoring them would report success while
        // silently dropping customer data.
        ignoreUnknownValues: false,
        rows: [built.row],
      };

      const insert = async (): Promise<BqApiResponse> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), context?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        try {
          const res = await fetch(url, {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
          return { status: res.status, text: await res.text() };
        } finally {
          clearTimeout(timer);
        }
      };

      try {
        let res = await insert();

        // Best-effort schema repair. Accepted DDL gets a bounded local retry
        // window because streaming metadata can lag table metadata.
        //   - table missing (404)                        → create it
        //   - table missing the column(s) we write        → add them
        //     ("no such field"), or has no schema at all
        //     ("has no schema" — an empty pre-created table)
        // Mode-agnostic: json_column adds its single payload column; columns
        // adds the row's leaf keys. The messages appear either in a 200-body
        // insertErrors list (columns) or a 400 error body (schemaless table).
        let repairOutcome: SchemaRepairOutcome | null = null;
        if (res.status === 404) {
          let created: CreateTableOutcome;
          try {
            created = await createTable(
              accessToken,
              projectId,
              dataset,
              binding.table,
              managedSchemaFields,
            );
          } catch {
            created = "retry";
          }

          if (created === "created") {
            repairOutcome = "ready";
          } else if (created === "exists") {
            // A concurrent creator may have used a different first-row schema.
            // Merge our desired fields before attempting the stream again.
            try {
              repairOutcome = await patchTableAddColumns(
                accessToken,
                projectId,
                dataset,
                binding.table,
                managedSchemaFields,
                binding.schema_evolution === "add_columns",
              );
            } catch {
              repairOutcome = "retry";
            }
          } else {
            repairOutcome = created;
          }
        } else if ((res.status === 200 || res.status === 400) && MISSING_SCHEMA_PATTERN.test(res.text)) {
          try {
            repairOutcome = await patchTableAddColumns(
              accessToken,
              projectId,
              dataset,
              binding.table,
              managedSchemaFields,
              binding.schema_evolution === "add_columns",
            );
          } catch {
            repairOutcome = "retry";
          }
        }

        if (repairOutcome === "blocked") {
          return attemptOf(context, destination, "dead", {
            status: res.status,
            code: "bigquery_schema_change_required",
            error: "Incoming fields are missing from the BigQuery table. The table was left unchanged. Review downstream views, update the schema and replay, or explicitly enable add_columns on this route. No fields were discarded.",
          }, startedAt);
        }
        if (repairOutcome === "retry") {
          return attemptOf(
            context,
            destination,
            "retry",
            {
              status: res.status,
              error: "schema_repair_transient",
            },
            startedAt,
          );
        }
        if (repairOutcome === "ready") {
          const retried = await retryInsertAfterSchemaRepair(insert);
          res = retried.response;
          if (retried.propagationPending) {
            return attemptOf(
              context,
              destination,
              "retry",
              {
                status: res.status,
                error: "schema_propagation_pending",
              },
              startedAt,
            );
          }
        }

        // ---- classify the final result ----
        if (res.status === 401) {
          // Token rejected — drop just this SA's cached token so the next
          // attempt re-mints, then treat as permanent (a valid-but-
          // unauthorized SA won't self-heal by retrying).
          invalidateToken(sa);
          return attemptOf(
            context,
            destination,
            "dead",
            { status: 401, error: "bigquery_unauthorized" },
            startedAt,
          );
        }
        if (res.status === 403) {
          // 403 is overloaded in BigQuery: rate/quota limits are retryable,
          // genuine access-denied is not.
          const retryable = /rateLimitExceeded|quotaExceeded|backendError/i.test(res.text);
          return attemptOf(
            context,
            destination,
            retryable ? "retry" : "dead",
            {
              status: 403,
              error: retryable ? "bigquery_quota_limited" : "bigquery_forbidden",
            },
            startedAt,
          );
        }
        if (res.status === 404) {
          return attemptOf(
            context,
            destination,
            "dead",
            { status: 404, error: "bigquery_not_found" },
            startedAt,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          return attemptOf(
            context,
            destination,
            "retry",
            { status: res.status, error: "bigquery_transient_http" },
            startedAt,
          );
        }
        if (res.status >= 400) {
          return attemptOf(
            context,
            destination,
            "dead",
            { status: res.status, error: "bigquery_http_error" },
            startedAt,
          );
        }

        // 2xx: insertAll returns 200 even when rows fail — the row outcome is
        // in `insertErrors`. No insertErrors ⇒ the row landed.
        let parsed: InsertAllResponse;
        try {
          parsed = JSON.parse(res.text) as InsertAllResponse;
        } catch {
          return attemptOf(
            context,
            destination,
            "retry",
            { status: res.status, error: "non_json_response" },
            startedAt,
          );
        }
        const rowErrors = parsed.insertErrors?.[0]?.errors ?? [];
        if (rowErrors.length === 0) {
          return attemptOf(
            context,
            destination,
            "success",
            { status: res.status, table: `${projectId}.${dataset}.${binding.table}` },
            startedAt,
          );
        }
        // Any retryable reason among the row's errors ⇒ retry the whole row;
        // otherwise it's a schema/data problem that won't fix itself ⇒ dead.
        const retryable = rowErrors.some((e) => e.reason && RETRYABLE_ROW_REASONS.has(e.reason));
        let schemaMismatches: BqCompatIssue[] = [];
        if (!retryable && rowErrors.some((error) => error.reason === "invalid")) {
          try {
            schemaMismatches = await diagnoseSchemaMismatches(
              accessToken,
              projectId,
              dataset,
              binding.table,
              desiredSchemaFields,
            );
          } catch {
            // Diagnostic enrichment is best-effort. Preserve BigQuery's
            // original row error when metadata cannot be read.
          }
        }
        return attemptOf(
          context,
          destination,
          retryable ? "retry" : "dead",
          {
            status: res.status,
            ...(schemaMismatches[0]
              ? { error: actionableMismatchMessage(schemaMismatches[0]) }
              : {}),
            insertErrors: rowErrors.slice(0, 8).map((e) => ({
              reason: e.reason,
            })),
            ...(schemaMismatches.length > 0
              ? { schemaMismatches: schemaMismatches.slice(0, 8) }
              : {}),
          },
          startedAt,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const transient = TRANSIENT_ERROR_PATTERNS.some((re) => re.test(message))
          || (err instanceof Error && err.name === "AbortError");
        return attemptOf(
          context,
          destination,
          transient ? "retry" : "dead",
          { error: transient ? "bigquery_delivery_transient" : "bigquery_delivery_failed" },
          startedAt,
        );
      }
    },
  };
}
