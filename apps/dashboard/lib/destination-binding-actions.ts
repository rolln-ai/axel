"use server";

import "server-only";
import { Pool } from "pg";
import { MongoClient } from "mongodb";
import {
  connectionHostSsrfReason,
  pgSslOption,
  expectedBigQuerySchema,
  compareBigQuerySchemas,
  typedColumns,
  bigQueryRowForEvent,
  type BigQueryWriteMode,
  type BqCompatResult,
} from "@axel/shared";
import { requireSession } from "./session";
import { requireActiveWorkspace, requireWritableRole } from "./auth-guards";
import { db } from "./db";
import { credentialAad, decryptCredentialBlob } from "./credentials";
import {
  listPostgresTables,
  listMongoCollections,
  listDatabricksSqlTables,
  listBigQueryTables,
  listBigQueryDatasets,
  listBigQueryTablesForDataset,
  listBigQueryDatasetsForCredentials,
  listBigQueryTablesForCredentials,
  introspectBigQueryDestination,
  CONNECTION_TIMEOUT_MS,
} from "./destination-inspect";
import { sampleSourceEvents } from "./data-contracts/sampler";
import type { DestinationType } from "./destination-defaults";

/**
 * Server actions used by the route-wiring UI to (a) list existing
 * targets on a destination (tables, collections, etc.) and (b) create
 * new ones when the user wants a fresh target.
 *
 * Auth: shared owner/admin role gate + active-workspace gate (suspended
 * workspaces cannot run DDL or probes). Editor users can wire routes but
 * not run DDL against the customer's data store.
 */

interface BindingTargetList {
  ok: true;
  type: DestinationType;
  /** Always a flat array of names — schema-prefixed where applicable. */
  targets: string[];
}

interface BindingActionError {
  ok: false;
  error: string;
}

export type BindingTargetResult = BindingTargetList | BindingActionError;
export type BindingCreateResult = BindingActionError | { ok: true; name: string };

/**
 * List the candidate write targets on a destination (tables for
 * postgres / databricks_sql, collections for mongo). The route-wiring
 * UI shows these as a dropdown alongside the "Create new" option.
 */
/** A sampled event and the exact BigQuery row Axel would write for it. */
export type BqDeliveredRowPreview = {
  /** The source event body that was sampled. */
  event: unknown;
  /** The row Axel would insert (null if the body can't be shaped for the mode). */
  row: Record<string, unknown> | null;
};

export type BigQueryCompatCheck =
  | { ok: false; error: string }
  | { ok: true; kind: "table_missing"; sampled: number; preview?: BqDeliveredRowPreview }
  | { ok: true; kind: "checked"; sampled: number; result: BqCompatResult; preview?: BqDeliveredRowPreview }
  // Event-free: no source events to diff against (new source, or none recent),
  // so we only flag the existing table's typed (non-STRING) columns.
  | { ok: true; kind: "table_only"; mode: BigQueryWriteMode; typed: Array<{ path: string; type: string }>; fieldCount: number };

/**
 * The workspace's streams (sources), for the "sample a real event from an
 * existing stream" picker in the compatibility check. Lets an operator wiring a
 * new destination borrow events from a stream that's already flowing (e.g. their
 * bronze pipeline) to validate a new table before any delivery.
 */
export async function listSampleableStreamsAction(): Promise<
  { ok: true; streams: Array<{ id: string; name: string }> } | { ok: false; error: string }
> {
  try {
    const session = await requireSession();
    const workspaceId = session.activeWorkspace.workspace_id;
    const rows = await db().query<{ id: string; name: string | null }>(
      `SELECT id, name FROM sources WHERE workspace_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [workspaceId],
    );
    return { ok: true, streams: rows.rows.map((r) => ({ id: r.id, name: r.name ?? r.id })) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Couldn't list streams." };
  }
}

const BQ_WRITE_MODES: BigQueryWriteMode[] = ["json_column", "columns", "nested_records", "typed_records"];

/**
 * Pre-flight: sample the route source's recent events, compute the BigQuery
 * schema Axel would write for the chosen mode, read the existing table's
 * declared schema, and diff them — so an operator sees BEFORE wiring whether
 * incoming events will fit (the headline risk being Axel's STRING leaves vs a
 * typed existing column). Owner/admin only (opens a connection to the customer
 * BigQuery). A non-existent table is trivially compatible (Axel creates it).
 */
export async function checkBigQueryCompatibilityAction(input: {
  destinationId: string;
  /** Omit (or pass empty) when the source doesn't exist yet — the check falls
   * back to a table-only heads-up. */
  sourceId?: string;
  dataset?: string;
  table: string;
  mode: string;
  payloadColumn?: string;
}): Promise<BigQueryCompatCheck> {
  try {
    const session = await requireSession();
    const workspaceId = session.activeWorkspace.workspace_id;
    const roleError = requireWritableRole(session.activeWorkspace.role);
    if (roleError) return { ok: false, error: roleError };
    const wsError = requireActiveWorkspace(session.activeWorkspace);
    if (wsError) return { ok: false, error: wsError };
    const table = input.table.trim();
    if (!table) return { ok: false, error: "Pick a table first." };

    const typeRow = await db().query<{ type: DestinationType }>(
      `SELECT type FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [input.destinationId, workspaceId],
    );
    if (typeRow.rows[0]?.type !== "bigquery") return { ok: false, error: "Not a BigQuery destination." };

    const mode: BigQueryWriteMode = BQ_WRITE_MODES.includes(input.mode as BigQueryWriteMode)
      ? (input.mode as BigQueryWriteMode)
      : "nested_records";

    // Sample the chosen stream (may be the route's own source or another stream
    // the operator picked to borrow events from). With no source (or no recent
    // events) we fall back to flagging the table's typed columns below.
    const payloadColumn = input.payloadColumn || "payload";
    const samples = input.sourceId
      ? await sampleSourceEvents(workspaceId, input.sourceId, { maxEvents: 50, maxDays: 30 })
      : [];
    const preview: BqDeliveredRowPreview | undefined =
      samples.length > 0
        ? { event: samples[0]!.payload, row: bigQueryRowForEvent(samples[0]!.payload, mode, payloadColumn) }
        : undefined;

    const existing = await introspectBigQueryDestination(input.destinationId, workspaceId, {
      ...(input.dataset ? { dataset: input.dataset } : {}),
      table,
    });
    if (existing.kind === "missing") {
      return { ok: true, kind: "table_missing", sampled: samples.length, ...(preview ? { preview } : {}) };
    }
    if (samples.length === 0) {
      return {
        ok: true,
        kind: "table_only",
        mode,
        typed: typedColumns(existing.fields),
        fieldCount: existing.fields.length,
      };
    }

    const expected = expectedBigQuerySchema(
      samples.map((s) => s.payload),
      mode,
      payloadColumn,
    );
    return {
      ok: true,
      kind: "checked",
      sampled: samples.length,
      result: compareBigQuerySchemas(expected, existing.fields),
      ...(preview ? { preview } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Compatibility check failed." };
  }
}

export async function listDestinationTargets(
  destinationId: string,
): Promise<BindingTargetResult> {
  try {
    const session = await requireSession();
    const workspaceId = session.activeWorkspace.workspace_id;
    const typeRow = await db().query<{ type: DestinationType }>(
      `SELECT type FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [destinationId, workspaceId],
    );
    const type = typeRow.rows[0]?.type;
    if (!type) return { ok: false, error: "Destination not found." };

    if (type === "postgres") {
      const list = await listPostgresTables(destinationId, workspaceId);
      return {
        ok: true,
        type,
        targets: list.tables.map((t) => (t.schema === "public" ? t.name : `${t.schema}.${t.name}`)),
      };
    }
    if (type === "mongodb") {
      const list = await listMongoCollections(destinationId, workspaceId);
      return { ok: true, type, targets: list.collections };
    }
    if (type === "databricks_sql") {
      const list = await listDatabricksSqlTables(destinationId, workspaceId);
      return { ok: true, type, targets: list.tables.map((t) => t.name) };
    }
    if (type === "bigquery") {
      const list = await listBigQueryTables(destinationId, workspaceId);
      return { ok: true, type, targets: list.tables.map((t) => `${t.schema}.${t.name}`) };
    }
    // databricks_volume / s3 / r2 / http / webhook don't introspect.
    return { ok: true, type, targets: [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not list targets." };
  }
}

export type BigQueryListResult =
  | { ok: true; values: string[] }
  | { ok: false; error: string };

/**
 * List BigQuery datasets for the guided dataset+table picker. Accepts either a
 * saved destination id (route binding) or just-entered credentials
 * (destination-creation flow, before the destination is saved).
 */
export async function listBigQueryDatasetsAction(input: {
  destinationId?: string;
  projectId?: string;
  serviceAccountJson?: string;
}): Promise<BigQueryListResult> {
  try {
    const session = await requireSession();
    const workspaceId = session.activeWorkspace.workspace_id;
    let values: string[];
    if (input.destinationId) {
      values = await listBigQueryDatasets(input.destinationId, workspaceId);
    } else if (input.projectId && input.serviceAccountJson) {
      values = await listBigQueryDatasetsForCredentials(input.projectId, input.serviceAccountJson);
    } else {
      return { ok: false, error: "Provide a destination or BigQuery credentials." };
    }
    return { ok: true, values };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not list datasets." };
  }
}

/** List tables in a chosen dataset for the guided picker (same input shapes). */
export async function listBigQueryTablesAction(input: {
  destinationId?: string;
  projectId?: string;
  serviceAccountJson?: string;
  dataset: string;
}): Promise<BigQueryListResult> {
  try {
    const session = await requireSession();
    const workspaceId = session.activeWorkspace.workspace_id;
    if (!input.dataset) return { ok: false, error: "Pick a dataset first." };
    let values: string[];
    if (input.destinationId) {
      values = await listBigQueryTablesForDataset(input.destinationId, workspaceId, input.dataset);
    } else if (input.projectId && input.serviceAccountJson) {
      values = await listBigQueryTablesForCredentials(
        input.projectId,
        input.serviceAccountJson,
        input.dataset,
      );
    } else {
      return { ok: false, error: "Provide a destination or BigQuery credentials." };
    }
    return { ok: true, values };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not list tables." };
  }
}

interface DestinationCreds {
  type: DestinationType;
  config: Record<string, unknown>;
  secrets: Record<string, string>;
}

async function loadDestinationCreds(
  destinationId: string,
  workspaceId: string,
): Promise<DestinationCreds | null> {
  const result = await db().query<{
    type: DestinationType;
    config: Record<string, unknown>;
    credentials_ref: string | null;
    ciphertext: Buffer | null;
    nonce: Buffer | null;
    auth_tag: Buffer | null;
    encryption_version: number | null;
  }>(
    `SELECT d.type, d.config, d.credentials_ref,
            dc.ciphertext, dc.nonce, dc.auth_tag, dc.encryption_version
       FROM destinations d
       LEFT JOIN destination_credentials dc ON dc.id = d.credentials_ref
      WHERE d.id = $1 AND d.workspace_id = $2
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  let secrets: Record<string, string> = {};
  if (row.credentials_ref && row.ciphertext && row.nonce && row.auth_tag) {
    const plain = await decryptCredentialBlob(
      {
        ciphertext: row.ciphertext,
        nonce: row.nonce,
        auth_tag: row.auth_tag,
        ...(row.encryption_version != null ? { encryption_version: row.encryption_version } : {}),
      },
      credentialAad(workspaceId, destinationId),
    );
    secrets = JSON.parse(plain) as Record<string, string>;
  }
  return { type: row.type, config: row.config, secrets };
}

const SAFE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/**
 * Create a new Postgres table on the destination's database. Used by
 * the route-wiring UI's "Create new" option for the binding picker.
 *
 * The created shell is intentionally minimal — `id bigserial PRIMARY
 * KEY, received_at timestamptz NOT NULL DEFAULT now()`. The Postgres
 * connector adds columns lazily at first insert based on the chosen
 * binding mode (jsonb_blob → "payload" jsonb, dotted_columns → one
 * column per leaf key with type inferred from the value).
 */
export async function createPostgresTable(
  destinationId: string,
  tableName: string,
): Promise<BindingCreateResult> {
  try {
    const session = await requireSession();
    const roleError = requireWritableRole(session.activeWorkspace.role);
    if (roleError) return { ok: false, error: roleError };
    const wsError = requireActiveWorkspace(session.activeWorkspace);
    if (wsError) return { ok: false, error: wsError };
    const workspaceId = session.activeWorkspace.workspace_id;

    if (!SAFE_NAME.test(tableName)) {
      return { ok: false, error: "Table name must be 1–63 chars, letters/digits/_ only, start with letter." };
    }

    const creds = await loadDestinationCreds(destinationId, workspaceId);
    if (!creds || creds.type !== "postgres") {
      return { ok: false, error: "Not a Postgres destination." };
    }
    const connStr = creds.secrets.connection_string;
    if (!connStr) return { ok: false, error: "Missing connection_string." };
    const ssrfReason = connectionHostSsrfReason(connStr);
    if (ssrfReason) return { ok: false, error: `Connection blocked (${ssrfReason}).` };

    const pool = new Pool({
      connectionString: connStr,
      ssl: pgSslOption(connStr),
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      max: 1,
    });
    try {
      // Quoted but the regex above guarantees safe chars; defense in depth.
      await pool.query(
        `CREATE TABLE IF NOT EXISTS "${tableName}" (
           id bigserial PRIMARY KEY,
           received_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      return { ok: true, name: tableName };
    } finally {
      await pool.end();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create table." };
  }
}

/**
 * Create a new MongoDB collection on the destination's database.
 * Mongo creates collections lazily on first write, but doing it up
 * front lets the dropdown surface the choice and avoids the "did it
 * land?" round-trip after wiring a route.
 */
export async function createMongoCollection(
  destinationId: string,
  collectionName: string,
): Promise<BindingCreateResult> {
  try {
    const session = await requireSession();
    const roleError = requireWritableRole(session.activeWorkspace.role);
    if (roleError) return { ok: false, error: roleError };
    const wsError = requireActiveWorkspace(session.activeWorkspace);
    if (wsError) return { ok: false, error: wsError };
    const workspaceId = session.activeWorkspace.workspace_id;

    if (!SAFE_NAME.test(collectionName)) {
      return { ok: false, error: "Collection name must be 1–63 chars, letters/digits/_ only." };
    }

    const creds = await loadDestinationCreds(destinationId, workspaceId);
    if (!creds || creds.type !== "mongodb") {
      return { ok: false, error: "Not a MongoDB destination." };
    }
    const connStr = creds.secrets.connection_string;
    const database = (creds.config.database as string | undefined) ?? "";
    if (!connStr) return { ok: false, error: "Missing connection_string." };
    if (!database) return { ok: false, error: "Destination has no database configured." };

    const client = new MongoClient(connStr, {
      serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
      connectTimeoutMS: CONNECTION_TIMEOUT_MS,
      maxPoolSize: 1,
    });
    try {
      await client.connect();
      await client.db(database).createCollection(collectionName);
      return { ok: true, name: collectionName };
    } catch (err) {
      // Mongo throws "Collection already exists" on duplicate; treat as success
      // for idempotency (the dropdown will pick it up on next list).
      const msg = err instanceof Error ? err.message : String(err);
      if (/already exists/i.test(msg)) return { ok: true, name: collectionName };
      throw err;
    } finally {
      await client.close();
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create collection." };
  }
}

/**
 * List / create targets straight from a connection string — for the New Source
 * wizard's NEW-destination path, where the destination doesn't exist yet so
 * `listDestinationTargets` (which loads stored creds by id) can't be used. The
 * connection string is the same one the user is about to save; session +
 * owner/admin gated so this isn't an open port scanner.
 */
export async function listTablesForConnection(
  type: string,
  connectionString: string,
  database?: string,
): Promise<BindingTargetResult> {
  try {
    const session = await requireSession();
    const roleError = requireWritableRole(session.activeWorkspace.role);
    if (roleError) return { ok: false, error: roleError };
    const wsError = requireActiveWorkspace(session.activeWorkspace);
    if (wsError) return { ok: false, error: wsError };
    const connStr = connectionString.trim();
    if (!connStr) return { ok: false, error: "Enter a connection string first." };
    // SSRF guard: this connection string is operator-supplied and we dial it
    // server-side, so block loopback/link-local/private/metadata hosts before
    // opening any socket (the pull connectors apply the same check at save time).
    const ssrfReason = connectionHostSsrfReason(connStr);
    if (ssrfReason) return { ok: false, error: `Connection blocked (${ssrfReason}).` };

    if (type === "postgres") {
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
            LIMIT 500`,
        );
        return {
          ok: true,
          type: "postgres",
          targets: result.rows.map((r) =>
            r.table_schema === "public" ? r.table_name : `${r.table_schema}.${r.table_name}`,
          ),
        };
      } finally {
        await pool.end().catch(() => {});
      }
    }
    if (type === "mongodb") {
      const dbName = (database ?? "").trim();
      if (!dbName) return { ok: false, error: "Enter the database name to list collections." };
      const client = new MongoClient(connStr, {
        serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
        connectTimeoutMS: CONNECTION_TIMEOUT_MS,
        maxPoolSize: 1,
      });
      try {
        await client.connect();
        const cols = await client.db(dbName).listCollections({}, { nameOnly: true }).toArray();
        return { ok: true, type: "mongodb", targets: cols.map((c) => c.name) };
      } finally {
        await client.close().catch(() => {});
      }
    }
    return { ok: true, type: type as DestinationType, targets: [] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not list targets." };
  }
}

export async function createTableForConnection(
  type: string,
  connectionString: string,
  name: string,
  database?: string,
): Promise<BindingCreateResult> {
  try {
    const session = await requireSession();
    const roleError = requireWritableRole(session.activeWorkspace.role);
    if (roleError) return { ok: false, error: roleError };
    const wsError = requireActiveWorkspace(session.activeWorkspace);
    if (wsError) return { ok: false, error: wsError };
    if (!SAFE_NAME.test(name)) {
      return { ok: false, error: "Name must be 1–63 chars, letters/digits/_ only, starting with a letter." };
    }
    const connStr = connectionString.trim();
    if (!connStr) return { ok: false, error: "Enter a connection string first." };
    // SSRF guard: this connection string is operator-supplied and we dial it
    // server-side, so block loopback/link-local/private/metadata hosts before
    // opening any socket (the pull connectors apply the same check at save time).
    const ssrfReason = connectionHostSsrfReason(connStr);
    if (ssrfReason) return { ok: false, error: `Connection blocked (${ssrfReason}).` };

    if (type === "postgres") {
      const pool = new Pool({
        connectionString: connStr,
        ssl: pgSslOption(connStr),
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        max: 1,
      });
      try {
        await pool.query(
          `CREATE TABLE IF NOT EXISTS "${name}" (
             id bigserial PRIMARY KEY,
             received_at timestamptz NOT NULL DEFAULT now()
           )`,
        );
        return { ok: true, name };
      } finally {
        await pool.end().catch(() => {});
      }
    }
    if (type === "mongodb") {
      const dbName = (database ?? "").trim();
      if (!dbName) return { ok: false, error: "Enter the database name first." };
      const client = new MongoClient(connStr, {
        serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
        connectTimeoutMS: CONNECTION_TIMEOUT_MS,
        maxPoolSize: 1,
      });
      try {
        await client.connect();
        await client.db(dbName).createCollection(name);
        return { ok: true, name };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(msg)) return { ok: true, name };
        throw err;
      } finally {
        await client.close().catch(() => {});
      }
    }
    return { ok: false, error: "This destination type has no tables to create here." };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Could not create target." };
  }
}
