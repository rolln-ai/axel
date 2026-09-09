import { lookup as dnsLookup } from "node:dns/promises";
import type { Connector, DeliveryContext } from "@axel/connectors";
import {
  assertResolvedHostSafe,
  sanitizeConnectorDiagnosticForStorage,
  validateDestinationUrl,
  type Destination,
  type DeliveryAttempt,
  type DatabricksSqlBinding,
  type DatabricksVolumeBinding,
} from "@axel/shared";
import { safeNodeFetch } from "../safe-outbound-fetch.js";

// DNS-rebinding guard: resolve the host and reject if it lands on a private/
// metadata IP, even when the literal string passed validateDestinationUrl.
const resolveAllIps = (hostname: string) => dnsLookup(hostname, { all: true });

interface DatabricksFetchInit {
  method: "POST" | "PUT";
  headers: Record<string, string>;
  body: string | ArrayBuffer;
  signal: AbortSignal;
  redirect: "manual";
}

export type DatabricksFetch = (
  url: string,
  init: DatabricksFetchInit,
) => Promise<DatabricksFetchResponse>;

interface DatabricksFetchResponse {
  status: number;
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  body?: {
    cancel(reason?: unknown): Promise<void>;
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(reason?: unknown): Promise<void>;
    };
  } | null;
}

const defaultDatabricksFetch: DatabricksFetch = (url, init) => safeNodeFetch(url, init);

/**
 * Databricks destination connectors.
 *
 * Two flavours, picked by the customer at create time based on their
 * throughput needs:
 *
 *   - `databricks_sql` (Statement Execution API): one INSERT per event into a
 *     Delta table on a SQL Warehouse. Ergonomic — rows just appear — but
 *     every event is a separate Delta commit, which produces small files and
 *     serialises on the table. Practical ceiling is ~10 events/sec sustained
 *     before it starts hurting. Good for low/moderate volume.
 *
 *   - `databricks_volume` (Files API): writes the raw event body as a JSON
 *     object into a Unity Catalog Volume. The customer points Auto Loader at
 *     the volume on their end, which streams files into Delta. This matches
 *     the pattern Databricks itself recommends for high-throughput webhook
 *     ingest. Same scaling shape as the s3/r2 connectors.
 *
 * Auth: both use a Databricks personal access token (or service-principal
 * token) supplied via `access_token`, sent as `Authorization: Bearer …`.
 *
 * Idempotency: at the destination layer we INSERT/PUT at-least-once and rely
 * on the delivery_idempotency table at the queue layer to suppress duplicate
 * dispatches. The volume connector additionally lands at a deterministic key
 * (event_id-based), so re-writes overwrite the same object — naturally
 * idempotent. The SQL connector cannot dedupe at insert time because Delta
 * doesn't enforce uniqueness constraints; if the customer cares, they can
 * MERGE on event_id from a downstream job.
 */

interface DatabricksSqlConfig {
  /** Workspace hostname without scheme. e.g. dbc-12345abc-de67.cloud.databricks.com */
  workspace_host: string;
  warehouse_id: string;
  catalog: string;
  /** Stored as `schema_name` because `schema` is a confusable form key. */
  schema_name: string;
  /** Legacy / default — used when binding is missing. */
  table?: string;
  /** Legacy / default — used when binding is missing. */
  payload_column?: string;
  /** Merged in from destination_credentials at delivery time. */
  access_token?: string;
}

interface DatabricksVolumeConfig {
  workspace_host: string;
  catalog: string;
  schema_name: string;
  /** Legacy / default — used when binding is missing. */
  volume?: string;
  key_prefix?: string;
  /** Default: "{date}/{event_id}.json". Tokens: {date}, {event_id}. */
  key_template?: string;
  access_token?: string;
}

function resolveDatabricksSqlBinding(
  binding: unknown,
  config: DatabricksSqlConfig,
): DatabricksSqlBinding | null {
  if (
    binding &&
    typeof binding === "object" &&
    "table" in binding &&
    typeof (binding as DatabricksSqlBinding).table === "string"
  ) {
    return binding as DatabricksSqlBinding;
  }
  if (config.table) {
    return {
      table: config.table,
      ...(config.payload_column !== undefined ? { payload_column: config.payload_column } : {}),
    };
  }
  return null;
}

function resolveDatabricksVolumeBinding(
  binding: unknown,
  config: DatabricksVolumeConfig,
): DatabricksVolumeBinding | null {
  if (
    binding &&
    typeof binding === "object" &&
    "volume" in binding &&
    typeof (binding as DatabricksVolumeBinding).volume === "string"
  ) {
    return binding as DatabricksVolumeBinding;
  }
  if (config.volume) {
    return {
      volume: config.volume,
      ...(config.key_prefix !== undefined ? { key_prefix: config.key_prefix } : {}),
      ...(config.key_template !== undefined ? { key_template: config.key_template } : {}),
    };
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DATABRICKS_RESPONSE_BYTES = 1024 * 1024;

const TRANSIENT_ERROR_PATTERNS = [/econnreset/i, /etimedout/i, /socket hang up/i, /fetch failed/i];

async function cancelResponseBody(response: DatabricksFetchResponse): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response is being discarded. A failed cancellation must not replace
    // the status-only diagnostic with transport details from a customer host.
  }
}

async function readBoundedResponseText(
  response: DatabricksFetchResponse,
  maxBytes = MAX_DATABRICKS_RESPONSE_BYTES,
): Promise<string> {
  const declaredLength = Number(response.headers?.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await cancelResponseBody(response);
    throw new Error("databricks_response_too_large");
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("databricks_response_too_large");
    }
    return text;
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("databricks_response_too_large");
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
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

/**
 * Whitelist for Databricks identifier components (catalog, schema, table,
 * column). Allows the chars that Unity Catalog accepts for unquoted-form
 * names plus hyphens (common in catalog names). Backticks themselves are
 * forbidden so a malicious value can't escape the quoting we add below.
 */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function quoteIdent(name: string, kind: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(`unsafe ${kind} identifier: ${name}`);
  }
  return `\`${name}\``;
}

/**
 * Strip an explicit https:// the user may have pasted in, and any trailing
 * slash. Databricks API URLs are always https, hostname-only.
 */
function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

// -------------------------------------------------------------------------
// databricks_sql — Statement Execution API
// -------------------------------------------------------------------------

interface StatementExecutionResponse {
  statement_id?: string;
  status?: {
    state?: "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "CLOSED";
    error?: { error_code?: string; message?: string };
  };
  result?: { data_array?: unknown[][] };
}

function databricksSqlModeOf(binding: DatabricksSqlBinding): "json_column" | "typed_columns" {
  const mode = (binding as DatabricksSqlBinding & { mode?: string }).mode;
  return mode === "typed_columns" ? "typed_columns" : "json_column";
}

// ---- typed_columns shaping ------------------------------------------------ //

type DbxColType = "BIGINT" | "DOUBLE" | "BOOLEAN" | "STRING";

interface DbxColumn {
  name: string;
  type: DbxColType;
  /** Parameter value — always a string; `type` tells Databricks how to cast. */
  value: string;
}

const DBX_MAX_DEPTH = 12;

/** Preserve the source JSON type per scalar leaf (typed_columns mode). */
function inferDbxColType(v: unknown): DbxColType {
  if (typeof v === "boolean") return "BOOLEAN";
  if (typeof v === "number") return Number.isInteger(v) ? "BIGINT" : "DOUBLE";
  return "STRING";
}

/**
 * Flatten a JSON object into underscore-joined typed columns. Scalars keep the
 * source type; arrays and objects past the depth cap land as STRING JSON. On a
 * sanitized-name collision the first occurrence wins (rare; mirrors the flat
 * warehouse shapers). Underscore names (not dotted) avoid Spark struct-access
 * ambiguity in unquoted queries.
 */
function flattenDbxColumns(obj: Record<string, unknown>): DbxColumn[] {
  const out: DbxColumn[] = [];
  const seen = new Set<string>();
  const add = (name: string, type: DbxColType, value: string): void => {
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, type, value });
  };
  const walk = (node: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [rawKey, v] of Object.entries(node)) {
      let seg = rawKey.replace(/[^A-Za-z0-9_]/g, "_");
      if (/^[0-9]/.test(seg)) seg = `_${seg}`;
      const name = prefix ? `${prefix}_${seg}` : seg;
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        add(name, "STRING", JSON.stringify(v));
      } else if (typeof v === "object") {
        if (depth < DBX_MAX_DEPTH && Object.keys(v).length > 0) {
          walk(v as Record<string, unknown>, name, depth + 1);
        } else {
          add(name, "STRING", JSON.stringify(v));
        }
      } else {
        add(name, inferDbxColType(v), String(v));
      }
    }
  };
  walk(obj, "", 0);
  return out;
}

function buildTypedInsert(
  tableRef: string,
  columns: DbxColumn[],
): { statement: string; parameters: Array<{ name: string; value: string; type: string }> } {
  const cols = columns.map((c, i) => ({ ...c, param: `p${i}` }));
  const colList = cols.map((c) => quoteIdent(c.name, "column")).join(", ");
  const valList = cols.map((c) => `:${c.param}`).join(", ");
  return {
    statement: `INSERT INTO ${tableRef} (${colList}) VALUES (${valList})`,
    parameters: cols.map((c) => ({ name: c.param, value: c.value, type: c.type })),
  };
}

/**
 * Same integer-first drift hazard BigQuery had (#367): a JSON number that is
 * integral in the first event cannot prove the field stays integral, and this
 * connector only ever ADDs columns — there is no widening ALTER path. Create
 * Axel-managed columns as DOUBLE so a later fractional value inserts instead
 * of failing permanently. Row parameters keep the exact per-value type
 * (Spark upcasts a BIGINT parameter into a DOUBLE column).
 */
function managedColumnType(type: DbxColType): DbxColType {
  return type === "BIGINT" ? "DOUBLE" : type;
}

function buildCreateTable(tableRef: string, columns: DbxColumn[]): string {
  const defs = columns
    .map((c) => `${quoteIdent(c.name, "column")} ${managedColumnType(c.type)}`)
    .join(", ");
  return `CREATE TABLE IF NOT EXISTS ${tableRef} (${defs}) USING DELTA`;
}

function buildAlterAddColumns(tableRef: string, columns: DbxColumn[]): string {
  const defs = columns
    .map((c) => `${quoteIdent(c.name, "column")} ${managedColumnType(c.type)}`)
    .join(", ");
  return `ALTER TABLE ${tableRef} ADD COLUMNS (${defs})`;
}

/** Column names already on the table, parsed from a `DESCRIBE TABLE` result. */
function existingColumnsFromDescribe(dataArray: unknown[][] | undefined): Set<string> {
  const cols = new Set<string>();
  for (const row of dataArray ?? []) {
    const name = Array.isArray(row) && typeof row[0] === "string" ? row[0].trim() : "";
    // The partition/detail sections start with a blank row then `# ...` headers.
    if (name === "" || name.startsWith("#")) break;
    cols.add(name.toLowerCase());
  }
  return cols;
}

// A statement failed because the table or a column doesn't exist yet (repairable
// with DDL) vs. a genuine data/type problem (a drifted value — dead-letter).
const TABLE_MISSING_PATTERN =
  /TABLE_OR_VIEW_NOT_FOUND|DELTA_(MISSING|TABLE_NOT_FOUND)|Table or view not found|cannot be found|does not exist/i;
const COLUMN_MISSING_PATTERN =
  /UNRESOLVED_COLUMN|cannot resolve .* given input columns|No such struct field|A column .* cannot be resolved/i;

// ---- statement execution -------------------------------------------------- //

interface StmtOutcome {
  transportError?: { message: string; transient: boolean };
  httpStatus?: number;
  nonJson?: boolean;
  state?: string;
  statementId?: string;
  errorMessage?: string;
  dataArray?: unknown[][];
}

async function executeStatement(
  fetchImpl: DatabricksFetch,
  host: string,
  token: string,
  warehouseId: string,
  statement: string,
  parameters: Array<{ name: string; value: string; type: string }>,
  timeoutMs: number,
): Promise<StmtOutcome> {
  const url = `https://${host}/api/2.0/sql/statements/`;
  const body = {
    warehouse_id: warehouseId,
    statement,
    ...(parameters.length > 0 ? { parameters } : {}),
    wait_timeout: "30s",
    on_wait_timeout: "CANCEL",
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: "manual",
    });
    if (res.status < 200 || res.status >= 300) {
      await cancelResponseBody(res);
      return { httpStatus: res.status };
    }
    const text = await readBoundedResponseText(res);
    let parsed: StatementExecutionResponse;
    try {
      parsed = JSON.parse(text) as StatementExecutionResponse;
    } catch {
      return { httpStatus: res.status, nonJson: true };
    }
    return {
      httpStatus: res.status,
      ...(parsed.status?.state !== undefined ? { state: parsed.status.state } : {}),
      ...(parsed.statement_id !== undefined ? { statementId: parsed.statement_id } : {}),
      ...(parsed.status?.error?.message !== undefined ? { errorMessage: parsed.status.error.message } : {}),
      ...(parsed.result?.data_array !== undefined ? { dataArray: parsed.result.data_array } : {}),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const transient =
      TRANSIENT_ERROR_PATTERNS.some((re) => re.test(message)) ||
      (err instanceof Error && err.name === "AbortError");
    return { transportError: { message, transient } };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a terminal INSERT outcome to a delivery attempt. */
function classifyStatement(
  out: StmtOutcome,
  context: DeliveryContext | undefined,
  destination: Destination,
  successResponse: Record<string, unknown>,
  startedAt: number,
): DeliveryAttempt {
  if (out.transportError) {
    return attemptOf(
      context,
      destination,
      out.transportError.transient ? "retry" : "dead",
      { error: sanitizeConnectorDiagnosticForStorage(out.transportError.message, 500) },
      startedAt,
    );
  }
  if (out.httpStatus !== undefined && (out.httpStatus < 200 || out.httpStatus >= 300)) {
    const s = out.httpStatus;
    const status = s === 429 || s >= 500 ? "retry" : "dead";
    return attemptOf(context, destination, status, { status: s }, startedAt);
  }
  if (out.nonJson) {
    return attemptOf(context, destination, "retry", { status: out.httpStatus, error: "non_json_response" }, startedAt);
  }
  if (out.state === "SUCCEEDED") {
    return attemptOf(context, destination, "success", { status: out.httpStatus, ...successResponse, statement_id: out.statementId }, startedAt);
  }
  if (out.state === "FAILED") {
    return attemptOf(
      context,
      destination,
      "dead",
      {
        status: out.httpStatus,
        statement_id: out.statementId,
        error: "databricks_statement_failed",
      },
      startedAt,
    );
  }
  // PENDING / RUNNING / CANCELED / CLOSED → warehouse warming up; retry.
  return attemptOf(context, destination, "retry", { status: out.httpStatus, statement_id: out.statementId, state: out.state ?? "unknown" }, startedAt);
}

export function createDatabricksSqlConnector(
  fetchImpl: DatabricksFetch = defaultDatabricksFetch,
): Connector<DatabricksSqlConfig> {
  return {
    type: "databricks_sql",
    async deliver(event, destination, context) {
      const startedAt = Date.now();
      const config = destination.config;

      if (!config.access_token) {
        return attemptOf(context, destination, "dead", { error: "access_token missing — credential not merged into config" }, startedAt);
      }

      const binding = resolveDatabricksSqlBinding(context?.binding, config);
      if (!binding) {
        return attemptOf(context, destination, "dead", { error: "no table binding configured for this route/destination" }, startedAt);
      }
      const mode = databricksSqlModeOf(binding);

      let tableRef: string;
      try {
        tableRef = [
          quoteIdent(config.catalog, "catalog"),
          quoteIdent(config.schema_name, "schema"),
          quoteIdent(binding.table, "table"),
        ].join(".");
      } catch (err) {
        return attemptOf(context, destination, "dead", { error: err instanceof Error ? err.message : String(err) }, startedAt);
      }

      // Build the INSERT (and, for typed_columns, the flattened columns used to
      // repair the schema). Validation errors here are permanent.
      let insert: { statement: string; parameters: Array<{ name: string; value: string; type: string }> };
      let typedColumns: DbxColumn[] | null = null;
      try {
        if (mode === "typed_columns") {
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(event));
          } catch {
            return attemptOf(context, destination, "dead", { error: "typed_columns mode requires a JSON object body; body is not JSON" }, startedAt);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return attemptOf(context, destination, "dead", { error: "typed_columns mode requires a JSON object body (got array/primitive)" }, startedAt);
          }
          typedColumns = flattenDbxColumns(parsed as Record<string, unknown>);
          if (typedColumns.length === 0) {
            return attemptOf(context, destination, "dead", { error: "typed_columns mode: event has no non-null fields to write" }, startedAt);
          }
          insert = buildTypedInsert(tableRef, typedColumns);
        } else {
          let payloadString: string;
          try {
            payloadString = JSON.stringify(JSON.parse(new TextDecoder().decode(event)));
          } catch {
            payloadString = new TextDecoder().decode(event);
          }
          const column = quoteIdent(binding.payload_column ?? config.payload_column ?? "payload", "column");
          insert = { statement: `INSERT INTO ${tableRef} (${column}) VALUES (:p)`, parameters: [{ name: "p", value: payloadString, type: "STRING" }] };
        }
      } catch (err) {
        return attemptOf(context, destination, "dead", { error: err instanceof Error ? err.message : String(err) }, startedAt);
      }

      const host = normalizeHost(config.workspace_host);
      const sqlSsrf = validateDestinationUrl(`https://${host}`);
      if (sqlSsrf) {
        return attemptOf(context, destination, "dead", { error: `ssrf_blocked: ${sqlSsrf}` }, startedAt);
      }
      const sqlDns = await assertResolvedHostSafe(host, resolveAllIps);
      if (sqlDns) {
        return attemptOf(context, destination, "dead", { error: `ssrf_blocked: ${sqlDns}` }, startedAt);
      }

      const token = config.access_token;
      const warehouse = config.warehouse_id;
      const successResponse = { table: `${config.catalog}.${config.schema_name}.${binding.table}` };
      const exec = (statement: string, parameters: Array<{ name: string; value: string; type: string }>) =>
        executeStatement(
          fetchImpl,
          host,
          token,
          warehouse,
          statement,
          parameters,
          context?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );

      let out = await exec(insert.statement, insert.parameters);

      // typed_columns can create missing tables. Existing columns are added
      // only when the binding explicitly permits schema evolution. A genuine
      // type conflict (drifted value) is NOT repairable and dead-letters.
      if (
        mode === "typed_columns" &&
        typedColumns &&
        out.state === "FAILED" &&
        (TABLE_MISSING_PATTERN.test(out.errorMessage ?? "") || COLUMN_MISSING_PATTERN.test(out.errorMessage ?? ""))
      ) {
        const describe = await exec(`DESCRIBE TABLE ${tableRef}`, []);
        if (describe.state === "FAILED" && TABLE_MISSING_PATTERN.test(describe.errorMessage ?? "")) {
          await exec(buildCreateTable(tableRef, typedColumns), []);
        } else if (describe.state === "SUCCEEDED") {
          const existing = existingColumnsFromDescribe(describe.dataArray);
          const missing = typedColumns.filter((c) => !existing.has(c.name.toLowerCase()));
          if (missing.length > 0) {
            if (binding.schema_evolution !== "add_columns") {
              return attemptOf(context, destination, "dead", {
                code: "databricks_schema_change_required",
                error: "Incoming fields are missing from the Delta table. The table was left unchanged. Review downstream queries, update the schema and replay, or explicitly enable add_columns on this route.",
              }, startedAt);
            }
            await exec(buildAlterAddColumns(tableRef, missing), []);
          }
        }
        out = await exec(insert.statement, insert.parameters);
      }

      return classifyStatement(out, context, destination, successResponse, startedAt);
    },
  };
}

// -------------------------------------------------------------------------
// databricks_volume — Files API
// -------------------------------------------------------------------------

function buildVolumeKey(input: {
  template: string;
  prefix: string | undefined;
  eventId: string;
  destinationId: string;
}): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filledTemplate = input.template
    .replaceAll("{date}", date)
    .replaceAll("{event_id}", input.eventId)
    .replaceAll("{destination_id}", input.destinationId);
  const prefix = input.prefix?.replace(/^\/+|\/+$/g, "") ?? "";
  const key = prefix ? `${prefix}/${filledTemplate}` : filledTemplate;
  return key.replace(/^\/+/, "");
}

export function createDatabricksVolumeConnector(
  fetchImpl: DatabricksFetch = defaultDatabricksFetch,
): Connector<DatabricksVolumeConfig> {
  return {
    type: "databricks_volume",
    async deliver(event, destination, context) {
      const startedAt = Date.now();
      const config = destination.config;

      if (!config.access_token) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "access_token missing — credential not merged into config" },
          startedAt,
        );
      }

      const binding = resolveDatabricksVolumeBinding(context?.binding, config);
      if (!binding) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: "no volume binding configured for this route/destination" },
          startedAt,
        );
      }

      // Validate identifiers up front.
      try {
        quoteIdent(config.catalog, "catalog");
        quoteIdent(config.schema_name, "schema");
        quoteIdent(binding.volume, "volume");
      } catch (err) {
        return attemptOf(
          context,
          destination,
          "dead",
          { error: err instanceof Error ? err.message : String(err) },
          startedAt,
        );
      }

      const key = buildVolumeKey({
        template: binding.key_template ?? config.key_template ?? "{date}/{event_id}.json",
        prefix: binding.key_prefix ?? config.key_prefix,
        eventId: context?.eventId ?? `unknown-${Date.now()}`,
        destinationId: destination.destination_id,
      });

      const host = normalizeHost(config.workspace_host);
      const volSsrf = validateDestinationUrl(`https://${host}`);
      if (volSsrf) {
        return attemptOf(context, destination, "dead", { error: `ssrf_blocked: ${volSsrf}` }, startedAt);
      }
      const volDns = await assertResolvedHostSafe(host, resolveAllIps);
      if (volDns) {
        return attemptOf(context, destination, "dead", { error: `ssrf_blocked: ${volDns}` }, startedAt);
      }
      // Files API: PUT https://<host>/api/2.0/fs/files/Volumes/<catalog>/<schema>/<volume>/<key>?overwrite=true
      const path = `/api/2.0/fs/files/Volumes/${encodeURIComponent(config.catalog)}/${encodeURIComponent(config.schema_name)}/${encodeURIComponent(binding.volume)}/${key
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;
      const url = `https://${host}${path}?overwrite=true`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetchImpl(url, {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            authorization: `Bearer ${config.access_token}`,
          },
          body: event,
          signal: controller.signal,
          redirect: "manual",
        });
        // 204 (success, no content) or 200 are the documented success codes.
        if (res.status === 200 || res.status === 204) {
          await cancelResponseBody(res);
          return attemptOf(
            context,
            destination,
            "success",
            {
              status: res.status,
              path: `/Volumes/${config.catalog}/${config.schema_name}/${binding.volume}/${key}`,
            },
            startedAt,
          );
        }
        await cancelResponseBody(res);
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          return attemptOf(
            context,
            destination,
            "dead",
            { status: res.status },
            startedAt,
          );
        }
        if (res.status === 429 || res.status >= 500) {
          return attemptOf(
            context,
            destination,
            "retry",
            { status: res.status },
            startedAt,
          );
        }
        return attemptOf(
          context,
          destination,
          "dead",
          { status: res.status },
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
          { error: transient ? "databricks_volume_transport_failed" : "databricks_volume_failed" },
          startedAt,
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
