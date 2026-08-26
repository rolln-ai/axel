import "server-only";
import { Pool } from "pg";
import { MongoClient } from "mongodb";
import { pgSslOption, validateDestinationUrl, type BqSchemaField } from "@axel/shared";
import { db } from "./db";
import { credentialAad, decryptCredentialBlob } from "./credentials";
import type { DestinationType } from "./destination-defaults";
import {
  parseServiceAccountJson,
  mintGoogleAccessToken,
  BIGQUERY_API_ROOT,
  BIGQUERY_SCOPE,
} from "./bigquery-auth";

/**
 * Read-only "data viewer" for destination types where it makes sense.
 *
 * For each supported type we:
 *   1. Look up the destination row + its encrypted credentials in the
 *      control-plane Postgres.
 *   2. Decrypt secrets in-process.
 *   3. Open a fresh, short-lived connection to the customer's data source.
 *   4. Run a single bounded read-only query (LIMIT N or find().limit(N)).
 *   5. Close the connection.
 *
 * Important guardrails:
 *   - Identifier names (table / collection) are validated with a strict regex
 *     before being interpolated into SQL — never substituted via parameter.
 *   - Connection timeout = 8s. If the customer's DB is slow or unreachable
 *     the dashboard surfaces a clear error rather than hanging the page.
 *   - We deliberately do NOT cache the connection: this is a low-frequency
 *     operator action, and persisting a customer-DB pool inside the
 *     dashboard is a fingerprintable surface we'd rather avoid.
 *   - The result set is hard-capped at 100 rows. Larger needs are an export
 *     job, not a dashboard preview.
 */

const INSPECT_ROW_LIMIT = 100;
export const CONNECTION_TIMEOUT_MS = 8_000;

export interface InspectableDestination {
  id: string;
  name: string;
  type: DestinationType;
  config: Record<string, unknown>;
  /** True when the destination has a credential blob attached. */
  has_credential: boolean;
}

interface DestinationRowWithBlob {
  id: string;
  workspace_id: string;
  name: string | null;
  type: DestinationType;
  config: Record<string, unknown>;
  status: "active" | "disabled";
  credentials_ref: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
  encryption_version: number | null;
}

async function loadDestinationWithBlob(
  destinationId: string,
  workspaceId: string,
): Promise<DestinationRowWithBlob | null> {
  const result = await db().query<DestinationRowWithBlob>(
    `SELECT d.id, d.workspace_id, d.name, d.type, d.config, d.status, d.credentials_ref,
            dc.ciphertext, dc.nonce, dc.auth_tag, dc.encryption_version
       FROM destinations d
       LEFT JOIN destination_credentials dc ON dc.id = d.credentials_ref
      WHERE d.id = $1 AND d.workspace_id = $2
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  return result.rows[0] ?? null;
}

async function decryptedSecrets(row: DestinationRowWithBlob): Promise<Record<string, string>> {
  if (!row.credentials_ref || !row.ciphertext || !row.nonce || !row.auth_tag) {
    return {};
  }
  const plain = await decryptCredentialBlob(
    {
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      auth_tag: row.auth_tag,
      ...(row.encryption_version != null ? { encryption_version: row.encryption_version } : {}),
    },
    credentialAad(row.workspace_id, row.id),
  );
  return JSON.parse(plain) as Record<string, string>;
}

// Identifier safety — match destination-side connectors. Underscores OK,
// must start with letter/underscore. Same regex used by delivery-edge's
// quoteIdent. We refuse anything else rather than try to escape it.
const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function quoteIdent(input: string): string {
  if (!SAFE_IDENT.test(input)) throw new Error(`identifier_rejected:${input}`);
  return `"${input}"`;
}

// Databricks identifiers allow hyphens (common in catalog names) and are
// quoted with backticks rather than double quotes. Mirrors the validation
// in the delivery-side databricks connector.
const SAFE_DATABRICKS_IDENT = /^[A-Za-z_][A-Za-z0-9_-]*$/;

function quoteDatabricksIdent(input: string): string {
  if (!SAFE_DATABRICKS_IDENT.test(input)) throw new Error(`identifier_rejected:${input}`);
  return `\`${input}\``;
}

// --- Postgres ------------------------------------------------------------- //

export interface PostgresInspectResult {
  kind: "rows";
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total_visible: number;
  truncated: boolean;
  /**
   * Estimated total row count for the table, pulled from `pg_class.reltuples`.
   * This is metadata-only (does NOT scan the table), so it's near-instant
   * even on multi-billion-row tables — but it's also stale if the table
   * hasn't been ANALYZEd recently. Mirrors the Mongo
   * `estimatedDocumentCount()` pattern further down. `null` means we
   * couldn't read it and don't want to fail the page just for a number.
   */
  total_estimate: number | null;
}

export interface PostgresTableList {
  kind: "tables";
  tables: Array<{ schema: string; name: string }>;
}

export async function listPostgresTables(
  destinationId: string,
  workspaceId: string,
): Promise<PostgresTableList> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "postgres") throw new Error("not_postgres_destination");
  const secrets = await decryptedSecrets(row);
  const connStr = secrets.connection_string;
  if (!connStr) throw new Error("missing_connection_string");

  const pool = new Pool({
    connectionString: connStr,
    ssl: pgSslOption(connStr),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    const result = await pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
          AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
        LIMIT 200`,
    );
    return {
      kind: "tables",
      tables: result.rows.map((r) => ({ schema: r.table_schema, name: r.table_name })),
    };
  } finally {
    await pool.end();
  }
}

async function inspectPostgresDestination(
  destinationId: string,
  workspaceId: string,
  options: { schema?: string; table: string; limit?: number },
): Promise<PostgresInspectResult> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "postgres") throw new Error("not_postgres_destination");
  const secrets = await decryptedSecrets(row);
  const connStr = secrets.connection_string;
  if (!connStr) throw new Error("missing_connection_string");

  const limit = Math.min(options.limit ?? INSPECT_ROW_LIMIT, INSPECT_ROW_LIMIT);
  const schemaIdent = options.schema ? quoteIdent(options.schema) : null;
  const tableIdent = quoteIdent(options.table);
  const fullyQualified = schemaIdent ? `${schemaIdent}.${tableIdent}` : tableIdent;

  const pool = new Pool({
    connectionString: connStr,
    ssl: pgSslOption(connStr),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    // Order by hidden ctid descending → we get the most-recently-inserted
    // rows first without needing a primary key. This is read-only and works
    // on every Postgres table.
    //
    // In parallel: read the planner's row estimate from pg_class. Looking
    // up by oid via to_regclass is cheap and survives quoted/unquoted names.
    // Soft-fail on the estimate so an unexpected pg_class permission error
    // doesn't break the page render.
    const [result, estimateRow] = await Promise.all([
      pool.query(`SELECT * FROM ${fullyQualified} ORDER BY ctid DESC LIMIT $1`, [limit]),
      pool.query<{ reltuples: string | number | null }>(
        `SELECT reltuples FROM pg_class WHERE oid = to_regclass($1)`,
        [`${schemaIdent ? `${schemaIdent}.` : ""}${tableIdent}`],
      ).catch((err: unknown) => {
        console.warn("[inspect] reltuples lookup failed:", err instanceof Error ? err.message : err);
        return { rows: [] as Array<{ reltuples: string | number | null }> };
      }),
    ]);
    const columns = result.fields.map((f) => f.name);
    const rows = result.rows as Array<Record<string, unknown>>;
    const reltuplesRaw = estimateRow.rows[0]?.reltuples;
    const reltuples = reltuplesRaw === null || reltuplesRaw === undefined
      ? null
      : Number(reltuplesRaw);
    // pg_class.reltuples is -1 on tables that have never been analyzed; treat
    // that as "we don't know" rather than rendering a confusing -1 in the UI.
    const total_estimate = reltuples !== null && Number.isFinite(reltuples) && reltuples >= 0
      ? Math.round(reltuples)
      : null;
    return {
      kind: "rows",
      columns,
      rows,
      total_visible: rows.length,
      truncated: rows.length === limit,
      total_estimate,
    };
  } finally {
    await pool.end();
  }
}

// --- MongoDB -------------------------------------------------------------- //

export interface MongoInspectResult {
  kind: "documents";
  documents: Array<Record<string, unknown>>;
  total_visible: number;
  truncated: boolean;
  /**
   * Estimated document count in the entire collection (not the page we're
   * showing). Uses Mongo's `estimatedDocumentCount` which reads metadata
   * rather than scanning — near-instant and accurate enough for a UI badge.
   * `null` means the count call failed and we don't want to fail the page
   * just for a number.
   */
  total_count: number | null;
}

export interface MongoCollectionList {
  kind: "collections";
  database: string;
  collections: string[];
}

export async function listMongoCollections(
  destinationId: string,
  workspaceId: string,
): Promise<MongoCollectionList> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "mongodb") throw new Error("not_mongodb_destination");
  const secrets = await decryptedSecrets(row);
  const connStr = secrets.connection_string;
  const database = (row.config.database as string | undefined) ?? "";
  if (!connStr) throw new Error("missing_connection_string");
  if (!database) throw new Error("missing_database");

  const client = new MongoClient(connStr, {
    serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
    connectTimeoutMS: CONNECTION_TIMEOUT_MS,
    maxPoolSize: 1,
  });
  try {
    await client.connect();
    const db = client.db(database);
    const cols = await db.listCollections({}, { nameOnly: true }).toArray();
    return {
      kind: "collections",
      database,
      collections: cols.map((c) => c.name).sort(),
    };
  } finally {
    await client.close();
  }
}

async function inspectMongoDestination(
  destinationId: string,
  workspaceId: string,
  options: { collection: string; limit?: number },
): Promise<MongoInspectResult> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "mongodb") throw new Error("not_mongodb_destination");
  const secrets = await decryptedSecrets(row);
  const connStr = secrets.connection_string;
  const database = (row.config.database as string | undefined) ?? "";
  if (!connStr) throw new Error("missing_connection_string");
  if (!database) throw new Error("missing_database");

  const limit = Math.min(options.limit ?? INSPECT_ROW_LIMIT, INSPECT_ROW_LIMIT);
  // Collection names in MongoDB allow more characters than SQL identifiers
  // (dots banned, $ banned), but we still apply a conservative regex.
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(options.collection)) {
    throw new Error(`identifier_rejected:${options.collection}`);
  }

  const client = new MongoClient(connStr, {
    serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
    connectTimeoutMS: CONNECTION_TIMEOUT_MS,
    maxPoolSize: 1,
  });
  try {
    await client.connect();
    const collection = client.db(database).collection(options.collection);
    // Run the page query and the total-count estimate in parallel so the
    // badge doesn't add latency. estimatedDocumentCount() reads metadata
    // (cheap) rather than scanning, which is what we want for a UI badge.
    // Wrap the count in a soft-failure: if it errors (rare permissions case),
    // we still want to render the documents page.
    const [docs, total] = await Promise.all([
      collection.find({}).sort({ _id: -1 }).limit(limit).toArray() as Promise<Array<Record<string, unknown>>>,
      collection.estimatedDocumentCount().catch((err: unknown) => {
        console.warn("[inspect] estimatedDocumentCount failed:", err instanceof Error ? err.message : err);
        return null as number | null;
      }),
    ]);
    return {
      kind: "documents",
      documents: docs,
      total_visible: docs.length,
      truncated: docs.length === limit,
      total_count: total,
    };
  } finally {
    await client.close();
  }
}

// --- Databricks SQL ------------------------------------------------------- //

export interface DatabricksSqlInspectResult {
  kind: "rows";
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total_visible: number;
  truncated: boolean;
  /** Always null for Databricks — Delta `DESCRIBE DETAIL` is too slow to do
   *  per-page-load. The badge just shows the visible count. Kept on the
   *  shape for compatibility with the existing rows renderer. */
  total_estimate: number | null;
}

export interface DatabricksSqlTableList {
  kind: "tables";
  tables: Array<{ schema: string; name: string }>;
}

// --- BigQuery ------------------------------------------------------------- //

export interface BigQueryInspectResult {
  kind: "rows";
  columns: string[];
  rows: Array<Record<string, unknown>>;
  total_visible: number;
  truncated: boolean;
  /** From jobs.query `totalRows` when present; null otherwise. */
  total_estimate: number | null;
}

export interface BigQueryTableList {
  kind: "tables";
  tables: Array<{ schema: string; name: string }>;
}

interface BigQueryCreds {
  projectId: string;
  serviceAccountJson: string;
}

// Dataset ids: letters/digits/underscores. TABLE names additionally allow
// hyphens (BigQuery permits them, e.g. `data-temp`) — safe inside the
// backtick-quoted ref since the regex still forbids backticks. Project ids
// also allow dots/hyphens/colons (legacy domain-scoped ids).
const SAFE_BQ_IDENT = /^[A-Za-z0-9_]{1,1024}$/;
const SAFE_BQ_TABLE = /^[A-Za-z0-9_-]{1,1024}$/;
const SAFE_BQ_PROJECT = /^[A-Za-z0-9._:-]+$/;

interface BigQueryQueryResponse {
  jobComplete?: boolean;
  totalRows?: string;
  schema?: { fields?: Array<{ name?: string; type?: string }> };
  rows?: Array<{ f?: Array<{ v?: unknown }> }>;
}

interface BigQueryDatasetListResponse {
  nextPageToken?: string;
  datasets?: Array<{ datasetReference?: { datasetId?: string } }>;
}

interface BigQueryTablesListResponse {
  tables?: Array<{ tableReference?: { tableId?: string } }>;
}

const BIGQUERY_DATASET_SCAN_LIMIT = 100;
const BIGQUERY_TABLES_PER_DATASET_LIMIT = 200;
const BIGQUERY_DATASET_SCAN_CONCURRENCY = 8;

async function loadBigQueryCreds(row: DestinationRowWithBlob): Promise<BigQueryCreds> {
  const secrets = await decryptedSecrets(row);
  const serviceAccountJson = secrets.service_account_json;
  if (!serviceAccountJson) throw new Error("missing_service_account_json");
  const projectId = String(row.config.project_id ?? "");
  if (!projectId) throw new Error("missing_project_id");
  if (!SAFE_BQ_PROJECT.test(projectId)) throw new Error(`identifier_rejected:${projectId}`);
  return { projectId, serviceAccountJson };
}

function bigQueryToken(creds: BigQueryCreds): Promise<string> {
  return mintGoogleAccessToken(parseServiceAccountJson(creds.serviceAccountJson), BIGQUERY_SCOPE);
}

/** Render a jobs.query cell value for the preview grid. */
function bqCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  // Nested RECORD / REPEATED come back as objects/arrays — stringify for preview.
  return JSON.stringify(v);
}

export async function listBigQueryTables(
  destinationId: string,
  workspaceId: string,
): Promise<BigQueryTableList> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "bigquery") throw new Error("not_bigquery_destination");
  const creds = await loadBigQueryCreds(row);
  const token = await bigQueryToken(creds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    // datasets.list only returns datasets visible to this service account. A
    // bounded concurrent tables.list scan makes route targets unambiguous as
    // `dataset.table`.
    const datasets = new Set<string>();
    let pageToken: string | undefined;
    try {
      do {
        const params = new URLSearchParams({
          maxResults: String(BIGQUERY_DATASET_SCAN_LIMIT - datasets.size),
        });
        if (pageToken) params.set("pageToken", pageToken);
        const parsed = await bigQueryGet<BigQueryDatasetListResponse>(
          `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(creds.projectId)}/datasets?${params}`,
          token,
          controller.signal,
        );
        for (const item of parsed.datasets ?? []) {
          const dataset = String(item.datasetReference?.datasetId ?? "");
          if (SAFE_BQ_IDENT.test(dataset)) datasets.add(dataset);
          if (datasets.size >= BIGQUERY_DATASET_SCAN_LIMIT) break;
        }
        pageToken = parsed.nextPageToken;
      } while (pageToken && datasets.size < BIGQUERY_DATASET_SCAN_LIMIT);
    } catch {
      // Some dataset-scoped service accounts cannot enumerate the project.
      // The operator can still enter a dataset.table target manually.
    }

    const datasetIds = [...datasets];
    const tables: Array<{ schema: string; name: string }> = [];
    const failures: Error[] = [];
    let successfulDatasets = 0;
    let nextDataset = 0;
    const scan = async () => {
      while (nextDataset < datasetIds.length) {
        const dataset = datasetIds[nextDataset++]!;
        const url =
          `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(creds.projectId)}` +
          `/datasets/${encodeURIComponent(dataset)}/tables?maxResults=${BIGQUERY_TABLES_PER_DATASET_LIMIT}`;
        try {
          const parsed = await bigQueryGet<BigQueryTablesListResponse>(
            url,
            token,
            controller.signal,
          );
          successfulDatasets += 1;
          for (const item of parsed.tables ?? []) {
            const name = String(item.tableReference?.tableId ?? "");
            if (SAFE_BQ_TABLE.test(name)) tables.push({ schema: dataset, name });
          }
        } catch (err) {
          failures.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BIGQUERY_DATASET_SCAN_CONCURRENCY, datasetIds.length) },
        () => scan(),
      ),
    );
    if (successfulDatasets === 0 && failures[0]) throw failures[0];
    return {
      kind: "tables",
      tables: tables.sort((a, b) =>
        a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Guided dataset + table picker (existing-datasets-only) ---------------- //
//
// The route target picker lists datasets (existing only — Axel doesn't create
// datasets) and, for a chosen dataset, its tables (the operator can also type a
// new table name, which the connector auto-creates on first delivery). Both a
// saved destination and just-entered credentials (destination-creation flow)
// resolve to a BigQueryCreds and share the same two API calls below.

async function bqListDatasets(creds: BigQueryCreds): Promise<string[]> {
  const token = await bigQueryToken(creds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const out: string[] = [];
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        maxResults: String(BIGQUERY_DATASET_SCAN_LIMIT - out.length),
      });
      if (pageToken) params.set("pageToken", pageToken);
      const parsed = await bigQueryGet<BigQueryDatasetListResponse>(
        `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(creds.projectId)}/datasets?${params}`,
        token,
        controller.signal,
      );
      for (const item of parsed.datasets ?? []) {
        const dataset = String(item.datasetReference?.datasetId ?? "");
        if (SAFE_BQ_IDENT.test(dataset)) out.push(dataset);
        if (out.length >= BIGQUERY_DATASET_SCAN_LIMIT) break;
      }
      pageToken = parsed.nextPageToken;
    } while (pageToken && out.length < BIGQUERY_DATASET_SCAN_LIMIT);
    return out.sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timer);
  }
}

async function bqListTablesInDataset(creds: BigQueryCreds, dataset: string): Promise<string[]> {
  if (!SAFE_BQ_IDENT.test(dataset)) throw new Error(`identifier_rejected:${dataset}`);
  const token = await bigQueryToken(creds);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const url =
      `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(creds.projectId)}` +
      `/datasets/${encodeURIComponent(dataset)}/tables?maxResults=${BIGQUERY_TABLES_PER_DATASET_LIMIT}`;
    const parsed = await bigQueryGet<BigQueryTablesListResponse>(url, token, controller.signal);
    return (parsed.tables ?? [])
      .map((t) => String(t.tableReference?.tableId ?? ""))
      .filter((name) => SAFE_BQ_TABLE.test(name))
      .sort((a, b) => a.localeCompare(b));
  } finally {
    clearTimeout(timer);
  }
}

/** List datasets for a saved BigQuery destination (route binding picker). */
export async function listBigQueryDatasets(destinationId: string, workspaceId: string): Promise<string[]> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "bigquery") throw new Error("not_bigquery_destination");
  return bqListDatasets(await loadBigQueryCreds(row));
}

/** List tables in a dataset for a saved BigQuery destination. */
export async function listBigQueryTablesForDataset(
  destinationId: string,
  workspaceId: string,
  dataset: string,
): Promise<string[]> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "bigquery") throw new Error("not_bigquery_destination");
  return bqListTablesInDataset(await loadBigQueryCreds(row), dataset);
}

/** List datasets for just-entered credentials (destination-creation flow). */
export async function listBigQueryDatasetsForCredentials(
  projectId: string,
  serviceAccountJson: string,
): Promise<string[]> {
  if (!SAFE_BQ_PROJECT.test(projectId)) throw new Error(`identifier_rejected:${projectId}`);
  return bqListDatasets({ projectId, serviceAccountJson });
}

/** List tables in a dataset for just-entered credentials. */
export async function listBigQueryTablesForCredentials(
  projectId: string,
  serviceAccountJson: string,
  dataset: string,
): Promise<string[]> {
  if (!SAFE_BQ_PROJECT.test(projectId)) throw new Error(`identifier_rejected:${projectId}`);
  return bqListTablesInDataset({ projectId, serviceAccountJson }, dataset);
}

async function bigQueryGet<T>(
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`bigquery_http_${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

interface BqRawField {
  name?: string;
  type?: string;
  mode?: string;
  fields?: BqRawField[];
}

/** Map a BigQuery tables.get field list to our BqSchemaField shape (recursively). */
function mapBqSchemaFields(raw: BqRawField[] | undefined): BqSchemaField[] {
  const out: BqSchemaField[] = [];
  for (const f of raw ?? []) {
    if (!f.name || !f.type) continue;
    const type = f.type.toUpperCase();
    const mode = f.mode === "REPEATED" || f.mode === "REQUIRED" ? f.mode : "NULLABLE";
    const field: BqSchemaField = { name: f.name, type, mode };
    if (type === "RECORD" || type === "STRUCT") field.fields = mapBqSchemaFields(f.fields);
    out.push(field);
  }
  return out;
}

export type BigQueryTableSchema =
  | { kind: "schema"; dataset: string; table: string; fields: BqSchemaField[] }
  | { kind: "missing"; dataset: string; table: string };

/**
 * Read an existing BigQuery table's declared schema (types + modes) via
 * tables.get — read-only, does not scan data. Returns `kind: "missing"` when the
 * table doesn't exist yet (Axel would create it → trivially compatible). This is
 * the input to the pre-flight compatibility check.
 */
export async function introspectBigQueryDestination(
  destinationId: string,
  workspaceId: string,
  options: { dataset?: string; table: string },
): Promise<BigQueryTableSchema> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "bigquery") throw new Error("not_bigquery_destination");
  const creds = await loadBigQueryCreds(row);
  const dataset = options.dataset?.trim() ?? "";
  if (!SAFE_BQ_IDENT.test(dataset)) throw new Error(`identifier_rejected:${dataset}`);
  if (!SAFE_BQ_TABLE.test(options.table)) throw new Error(`identifier_rejected:${options.table}`);
  const token = await bigQueryToken(creds);
  const url =
    `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(creds.projectId)}` +
    `/datasets/${encodeURIComponent(dataset)}/tables/${encodeURIComponent(options.table)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS);
  try {
    const resp = await bigQueryGet<{ schema?: { fields?: BqRawField[] } }>(url, token, controller.signal);
    return { kind: "schema", dataset, table: options.table, fields: mapBqSchemaFields(resp.schema?.fields) };
  } catch (err) {
    if (err instanceof Error && /bigquery_http_404/.test(err.message)) {
      return { kind: "missing", dataset, table: options.table };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function inspectBigQueryDestination(
  destinationId: string,
  workspaceId: string,
  options: { dataset?: string; table: string; limit?: number },
): Promise<BigQueryInspectResult> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "bigquery") throw new Error("not_bigquery_destination");
  const creds = await loadBigQueryCreds(row);
  const dataset = options.dataset?.trim() ?? "";
  if (!SAFE_BQ_IDENT.test(dataset)) throw new Error(`identifier_rejected:${dataset}`);
  if (!SAFE_BQ_TABLE.test(options.table)) throw new Error(`identifier_rejected:${options.table}`);

  const limit = Math.min(options.limit ?? INSPECT_ROW_LIMIT, INSPECT_ROW_LIMIT);
  const token = await bigQueryToken(creds);
  // Idents validated above, so the backtick-quoted ref can't be broken out of.
  const query = `SELECT * FROM \`${creds.projectId}.${dataset}.${options.table}\` LIMIT ${limit}`;
  const url = `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(creds.projectId)}/queries`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS + 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, useLegacySql: false, maxResults: limit, timeoutMs: 25_000 }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`bigquery_http_${res.status}: ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text) as BigQueryQueryResponse;
    if (parsed.jobComplete === false) {
      throw new Error("bigquery_query_incomplete: the query did not finish within 25s");
    }
    const columns = (parsed.schema?.fields ?? []).map((f, i) => f.name ?? `col${i}`);
    const rows = (parsed.rows ?? []).map((r) => {
      const record: Record<string, unknown> = {};
      const cells = r.f ?? [];
      for (let i = 0; i < columns.length; i++) {
        record[columns[i]!] = bqCell(cells[i]?.v);
      }
      return record;
    });
    return {
      kind: "rows",
      columns,
      rows,
      total_visible: rows.length,
      truncated: rows.length === limit,
      total_estimate: parsed.totalRows ? Number(parsed.totalRows) : null,
    };
  } finally {
    clearTimeout(timer);
  }
}

interface DatabricksSqlCreds {
  workspaceHost: string;
  warehouseId: string;
  catalog: string;
  schemaName: string;
  token: string;
}

async function loadDatabricksSqlCreds(row: DestinationRowWithBlob): Promise<DatabricksSqlCreds> {
  const secrets = await decryptedSecrets(row);
  const token = secrets.access_token;
  if (!token) throw new Error("missing_access_token");
  const workspaceHost = String(row.config.workspace_host ?? "").replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const warehouseId = String(row.config.warehouse_id ?? "");
  const catalog = String(row.config.catalog ?? "");
  const schemaName = String(row.config.schema_name ?? "");
  if (!workspaceHost) throw new Error("missing_workspace_host");
  if (!warehouseId) throw new Error("missing_warehouse_id");
  if (!catalog) throw new Error("missing_catalog");
  if (!schemaName) throw new Error("missing_schema_name");
  return { workspaceHost, warehouseId, catalog, schemaName, token };
}

interface DatabricksStatementResponse {
  status?: { state?: string; error?: { message?: string } };
  manifest?: { schema?: { columns?: Array<{ name?: string }> } };
  result?: { data_array?: unknown[][] };
}

/**
 * Run a single read-only statement against the customer's SQL Warehouse via
 * the Statement Execution API. Synchronous wait up to 30s — anything that
 * takes longer fails fast rather than blocking the page render.
 *
 * Safety: the caller supplies the fully-formed statement. This helper does
 * NOT validate it (Postgres-style READ ONLY transactions don't exist on
 * Databricks; the safety belt is the strict identifier validation upstream
 * + the fact that this function is only called from inspect/list helpers
 * that build SELECT-only SQL with quoted identifiers).
 */
async function runDatabricksStatement(
  creds: DatabricksSqlCreds,
  statement: string,
): Promise<{ columns: string[]; rows: Array<Record<string, unknown>> }> {
  // SSRF guard at the egress point: workspace_host is a bare hostname with no
  // inputType=url gate at create/update, so an authenticated user could repoint a
  // databricks destination at 169.254.169.254 / a private host and make THIS
  // dashboard-origin fetch reach internal infrastructure. Validate before the
  // request (the delivery-service runtime guards its own path separately).
  const hostReason = validateDestinationUrl(`https://${creds.workspaceHost}`);
  if (hostReason) throw new Error(`workspace_host blocked: ${hostReason}`);
  const url = `https://${creds.workspaceHost}/api/2.0/sql/statements/`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECTION_TIMEOUT_MS + 25_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.token}`,
      },
      body: JSON.stringify({
        warehouse_id: creds.warehouseId,
        statement,
        wait_timeout: "30s",
        on_wait_timeout: "CANCEL",
        format: "JSON_ARRAY",
        disposition: "INLINE",
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`databricks_http_${res.status}: ${text.slice(0, 300)}`);
    }
    const parsed = JSON.parse(text) as DatabricksStatementResponse;
    const state = parsed.status?.state;
    if (state !== "SUCCEEDED") {
      const message = parsed.status?.error?.message ?? `state=${state ?? "unknown"}`;
      throw new Error(`databricks_statement_${state ?? "unknown"}: ${message.slice(0, 300)}`);
    }
    const columns = (parsed.manifest?.schema?.columns ?? [])
      .map((c, i) => c.name ?? `col${i}`);
    const dataArray = parsed.result?.data_array ?? [];
    const rows = dataArray.map((row) => {
      const record: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        record[columns[i]!] = row[i] ?? null;
      }
      return record;
    });
    return { columns, rows };
  } finally {
    clearTimeout(timer);
  }
}

export async function listDatabricksSqlTables(
  destinationId: string,
  workspaceId: string,
): Promise<DatabricksSqlTableList> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "databricks_sql") throw new Error("not_databricks_sql_destination");
  const creds = await loadDatabricksSqlCreds(row);

  // INFORMATION_SCHEMA.TABLES is per-catalog. We scope to the configured
  // catalog+schema rather than enumerating every catalog the token can see.
  const catalogIdent = quoteDatabricksIdent(creds.catalog);
  const sql =
    `SELECT table_schema, table_name ` +
    `FROM ${catalogIdent}.information_schema.tables ` +
    `WHERE table_schema = '${creds.schemaName.replace(/'/g, "''")}' ` +
    `AND table_type IN ('MANAGED', 'EXTERNAL') ` +
    `ORDER BY table_name LIMIT 200`;
  // Validate the schema name as a plain identifier so the embedded literal
  // above can't carry quotes/semicolons even though we string-escape it.
  if (!SAFE_DATABRICKS_IDENT.test(creds.schemaName)) {
    throw new Error(`identifier_rejected:${creds.schemaName}`);
  }

  const { rows } = await runDatabricksStatement(creds, sql);
  return {
    kind: "tables",
    tables: rows.map((r) => ({
      schema: String(r.table_schema ?? creds.schemaName),
      name: String(r.table_name ?? ""),
    })).filter((t) => t.name.length > 0),
  };
}

async function inspectDatabricksSqlDestination(
  destinationId: string,
  workspaceId: string,
  options: { table: string; limit?: number },
): Promise<DatabricksSqlInspectResult> {
  const row = await loadDestinationWithBlob(destinationId, workspaceId);
  if (!row || row.type !== "databricks_sql") throw new Error("not_databricks_sql_destination");
  const creds = await loadDatabricksSqlCreds(row);

  const limit = Math.min(options.limit ?? INSPECT_ROW_LIMIT, INSPECT_ROW_LIMIT);
  const tableRef = [
    quoteDatabricksIdent(creds.catalog),
    quoteDatabricksIdent(creds.schemaName),
    quoteDatabricksIdent(options.table),
  ].join(".");
  const sql = `SELECT * FROM ${tableRef} LIMIT ${limit}`;

  const { columns, rows } = await runDatabricksStatement(creds, sql);
  return {
    kind: "rows",
    columns,
    rows,
    total_visible: rows.length,
    truncated: rows.length === limit,
    total_estimate: null,
  };
}

/**
 * Single entry-point used by the dashboard: figure out the destination type
 * + delegate to the matching inspect helper. Returns a discriminated union
 * the page renders directly.
 */
export type InspectResult =
  | PostgresInspectResult
  | PostgresTableList
  | MongoInspectResult
  | MongoCollectionList
  | DatabricksSqlInspectResult
  | DatabricksSqlTableList
  | BigQueryInspectResult
  | BigQueryTableList
  | { kind: "unsupported"; type: DestinationType }
  | { kind: "error"; message: string };

export async function inspectDestination(
  destinationId: string,
  workspaceId: string,
  options: { table?: string; collection?: string; schema?: string; limit?: number } = {},
): Promise<InspectResult> {
  try {
    const lookup = await loadDestinationWithBlob(destinationId, workspaceId);
    if (!lookup) return { kind: "error", message: "Destination not found in this workspace." };

    if (lookup.type === "postgres") {
      if (!options.table) return await listPostgresTables(destinationId, workspaceId);
      return await inspectPostgresDestination(destinationId, workspaceId, {
        ...(options.schema !== undefined ? { schema: options.schema } : {}),
        table: options.table,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    }
    if (lookup.type === "mongodb") {
      if (!options.collection) return await listMongoCollections(destinationId, workspaceId);
      return await inspectMongoDestination(destinationId, workspaceId, {
        collection: options.collection,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    }
    if (lookup.type === "databricks_sql") {
      if (!options.table) return await listDatabricksSqlTables(destinationId, workspaceId);
      return await inspectDatabricksSqlDestination(destinationId, workspaceId, {
        table: options.table,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    }
    if (lookup.type === "bigquery") {
      if (!options.table) return await listBigQueryTables(destinationId, workspaceId);
      return await inspectBigQueryDestination(destinationId, workspaceId, {
        ...(options.schema !== undefined ? { dataset: options.schema } : {}),
        table: options.table,
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
      });
    }
    return { kind: "unsupported", type: lookup.type };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Inspect failed.";
    return { kind: "error", message };
  }
}

export interface InspectableSummary {
  id: string;
  name: string;
  type: DestinationType;
  status: "active" | "disabled";
  config: Record<string, unknown>;
  has_credential: boolean;
  fingerprint_last4: string | null;
  fingerprint_sha256_prefix: string | null;
  /** AXE-27 circuit breaker state. */
  circuit_state: "closed" | "open" | "half_open" | "disabled";
  circuit_opened_at: string | null;
  circuit_consecutive_failures: number;
  circuit_threshold_failures: number;
  circuit_cooldown_seconds: number;
  /** AXE-28 delivery controls. */
  delivery_paused: boolean;
  delivery_paused_reason: string | null;
  rate_limit_rps: number | null;
  request_timeout_ms: number | null;
  retry_after_until: string | null;
}

/**
 * Public-safe summary of a destination, used by the detail page header /
 * edit form. Never returns plaintext secrets.
 */
export async function getDestinationSummary(
  destinationId: string,
  workspaceId: string,
): Promise<InspectableSummary | null> {
  const result = await db().query<{
    id: string;
    name: string | null;
    type: DestinationType;
    status: "active" | "disabled";
    config: Record<string, unknown>;
    credentials_ref: string | null;
    fingerprint_last4: string | null;
    fingerprint_sha256_prefix: string | null;
    circuit_state: "closed" | "open" | "half_open" | "disabled";
    circuit_opened_at: string | null;
    circuit_consecutive_failures: number;
    circuit_threshold_failures: number;
    circuit_cooldown_seconds: number;
    delivery_paused: boolean;
    delivery_paused_reason: string | null;
    rate_limit_rps: number | null;
    request_timeout_ms: number | null;
    retry_after_until: string | null;
  }>(
    `SELECT d.id, d.name, d.type, d.status, d.config, d.credentials_ref,
            dc.fingerprint_last4, dc.fingerprint_sha256_prefix,
            d.circuit_state, d.circuit_opened_at::text AS circuit_opened_at,
            d.circuit_consecutive_failures, d.circuit_threshold_failures,
            d.circuit_cooldown_seconds,
            d.delivery_paused, d.delivery_paused_reason,
            d.rate_limit_rps, d.request_timeout_ms,
            d.retry_after_until::text AS retry_after_until
       FROM destinations d
       LEFT JOIN destination_credentials dc ON dc.id = d.credentials_ref
      WHERE d.id = $1 AND d.workspace_id = $2
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name ?? row.id,
    type: row.type,
    status: row.status,
    config: row.config,
    has_credential: row.credentials_ref !== null,
    fingerprint_last4: row.fingerprint_last4,
    fingerprint_sha256_prefix: row.fingerprint_sha256_prefix,
    circuit_state: row.circuit_state,
    circuit_opened_at: row.circuit_opened_at,
    circuit_consecutive_failures: row.circuit_consecutive_failures,
    circuit_threshold_failures: row.circuit_threshold_failures,
    circuit_cooldown_seconds: row.circuit_cooldown_seconds,
    delivery_paused: row.delivery_paused,
    delivery_paused_reason: row.delivery_paused_reason,
    rate_limit_rps: row.rate_limit_rps,
    request_timeout_ms: row.request_timeout_ms,
    retry_after_until: row.retry_after_until,
  };
}
