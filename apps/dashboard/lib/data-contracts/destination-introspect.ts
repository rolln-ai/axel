import "server-only";
import pg from "pg";
import { pgSslOption } from "@axel/shared";
import { db } from "../db";
import { credentialAad, decryptCredentialBlob } from "../credentials";
import type {
  MongoIntrospection,
  PostgresIntrospection,
} from "./destination-mapping";

const { Pool } = pg;

/**
 * One-shot Postgres introspection for an Axel destination. Uses a
 * one-shot pool with a tight timeout and ends immediately so we don't
 * keep customer database sockets open longer than the introspection takes.
 *
 * Returns null when the destination isn't wired with a connection string
 * yet (e.g. the user saved config but no credential). UI surfaces that
 * as "couldn't read the target table" with a hint to check credentials.
 */
const CONNECTION_TIMEOUT_MS = 5_000;
const COLUMN_BUDGET = 200;

interface DestinationWithSecret {
  id: string;
  workspace_id: string;
  type: string;
  config: Record<string, unknown>;
  credentials_ref: string | null;
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
  encryption_version: number | null;
}

async function loadDestinationWithSecret(
  workspaceId: string,
  destinationId: string,
): Promise<DestinationWithSecret | null> {
  const result = await db().query<DestinationWithSecret>(
    `SELECT d.id, d.workspace_id, d.type, d.config, d.credentials_ref,
            dc.ciphertext, dc.nonce, dc.auth_tag, dc.encryption_version
       FROM destinations d
       LEFT JOIN destination_credentials dc ON dc.id = d.credentials_ref
      WHERE d.id = $1 AND d.workspace_id = $2
      LIMIT 1`,
    [destinationId, workspaceId],
  );
  return result.rows[0] ?? null;
}

function buildPostgresConnString(
  config: Record<string, unknown>,
  secrets: Record<string, string>,
): string | null {
  // Two valid shapes:
  //   1. secrets.postgres_url = "postgres://user:pass@host:port/db"
  //   2. config.host + config.port + config.database + secrets.user/password
  const direct = secrets.postgres_url ?? secrets.connection_string;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const host = typeof config.host === "string" ? config.host : null;
  const port = typeof config.port === "number" ? config.port : 5432;
  const database = typeof config.database === "string" ? config.database : null;
  const user = secrets.user ?? secrets.username;
  const password = secrets.password;
  if (!host || !database || !user) return null;
  const auth = password ? `${user}:${encodeURIComponent(password)}` : user;
  return `postgres://${auth}@${host}:${port}/${database}`;
}

async function decryptSecrets(d: DestinationWithSecret): Promise<Record<string, string>> {
  if (!d.credentials_ref || !d.ciphertext || !d.nonce || !d.auth_tag) return {};
  try {
    const plain = await decryptCredentialBlob(
      {
        ciphertext: d.ciphertext,
        nonce: d.nonce,
        auth_tag: d.auth_tag,
        ...(d.encryption_version != null ? { encryption_version: d.encryption_version } : {}),
      },
      credentialAad(d.workspace_id, d.id),
    );
    const parsed = JSON.parse(plain) as Record<string, string>;
    return parsed;
  } catch {
    return {};
  }
}

export async function introspectPostgresDestination(
  workspaceId: string,
  destinationId: string,
  requestedTable?: string,
): Promise<PostgresIntrospection | null> {
  const dest = await loadDestinationWithSecret(workspaceId, destinationId);
  if (!dest || dest.type !== "postgres") return null;
  const secrets = await decryptSecrets(dest);
  const connStr = buildPostgresConnString(dest.config, secrets);
  if (!connStr) return null;

  // Postgres destinations don't carry a table on the destination itself — it's a
  // per-route binding — so callers pass the target explicitly. Fall back to a
  // config table only for destination shapes that do store one.
  const configTable =
    typeof dest.config.table === "string"
      ? (dest.config.table as string)
      : typeof dest.config.target_table === "string"
        ? (dest.config.target_table as string)
        : null;
  const targetTable = (requestedTable && requestedTable.trim()) || configTable;
  if (!targetTable) return null;

  // Parse "schema.table" or just "table" — default schema is public.
  const [maybeSchema, maybeTable] = targetTable.split(".");
  const schemaName = maybeTable ? maybeSchema! : "public";
  const tableName = maybeTable ?? maybeSchema!;

  const pool = new Pool({
    connectionString: connStr,
    ssl: pgSslOption(connStr),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 1_000,
    max: 1,
  });
  try {
    const cols = await pool.query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT column_name, data_type, is_nullable
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position
        LIMIT $3`,
      [schemaName, tableName, COLUMN_BUDGET],
    );
    if (cols.rows.length === 0) return null;

    // Compute "is_unique": primary keys + columns with unique constraints.
    const constraints = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
          AND kcu.table_name = tc.table_name
        WHERE tc.table_schema = $1
          AND tc.table_name = $2
          AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')`,
      [schemaName, tableName],
    );
    const uniqueColumns = new Set(constraints.rows.map((r) => r.column_name));

    return {
      table: maybeTable ? targetTable : `public.${tableName}`,
      columns: cols.rows.map((c) => ({
        name: c.column_name,
        data_type: c.data_type,
        is_nullable: c.is_nullable === "YES",
        is_unique: uniqueColumns.has(c.column_name),
      })),
    };
  } finally {
    await pool.end().catch(() => {});
  }
}

/**
 * Mongo introspection. Hooks into the same destination loader, decrypts
 * the connection URI, samples the target collection's field names.
 * Returns null if connection or collection name aren't configured.
 */
export async function introspectMongoDestination(
  workspaceId: string,
  destinationId: string,
  requestedCollection?: string,
): Promise<MongoIntrospection | null> {
  const dest = await loadDestinationWithSecret(workspaceId, destinationId);
  if (!dest || dest.type !== "mongodb") return null;
  const secrets = await decryptSecrets(dest);
  const connUri =
    secrets.mongodb_url ??
    secrets.connection_string ??
    secrets.uri ??
    null;
  // Like Postgres, the target collection is a per-route binding, so callers pass
  // it explicitly; fall back to config for shapes that store one.
  const configCollection =
    typeof dest.config.collection === "string" ? (dest.config.collection as string) : null;
  const collection = (requestedCollection && requestedCollection.trim()) || configCollection;
  if (!connUri || !collection) return null;

  // Dynamic import keeps the mongodb driver out of bundles that don't need it.
  const { MongoClient } = await import("mongodb");
  const dbName =
    typeof dest.config.database === "string"
      ? (dest.config.database as string)
      : null;

  const client = new MongoClient(connUri, {
    serverSelectionTimeoutMS: CONNECTION_TIMEOUT_MS,
  });
  try {
    await client.connect();
    const db = dbName ? client.db(dbName) : client.db();
    const cursor = db.collection(collection).find({}, { limit: 20 });
    const docs = await cursor.toArray();
    const observed = new Set<string>();
    for (const doc of docs) {
      for (const key of Object.keys(doc)) observed.add(key);
    }
    return {
      collection,
      observed_fields: Array.from(observed),
    };
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}
