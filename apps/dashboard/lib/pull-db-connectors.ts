import "server-only";
/**
 * Sync-grade DB pull connectors for the dashboard runtime.
 *
 * The dashboard's manual "Sync now" (runDashboardPullSync) and the
 * production pull-worker both need real @axel/pull-connectors connectors
 * backed by Node DB drivers (pg / mongodb / @google-cloud/bigquery). The
 * connector package intentionally does NOT depend on those drivers — each
 * host injects a `connect` factory. This module is the dashboard's single
 * sync-grade factory.
 *
 * It mirrors apps/pull-worker/src/index.ts's connect factories exactly,
 * INCLUDING the Mongo ObjectId rehydration in `rehydrateCursors` — without
 * it, an `_id`-cursor `$gt` compares a 24-char string against an ObjectId,
 * which Mongo silently evaluates to an empty page (no error), so an
 * incremental sync would appear to succeed while pulling nothing.
 *
 * NOTE (tracked for triage): these factories are duplicated two ways
 * (here and in pull-worker). They should be hoisted into a shared package.
 */

import {
  createBigQueryConnector,
  createMongodbConnector,
  createPostgresConnector,
  type BigQueryClientLike,
  type BigQueryConfig,
  type BigQueryCredentials,
  type MongodbClientLike,
  type MongodbConfig,
  type PgClient,
  type PostgresConfig,
  type PullConnector,
  type PullSourceType,
} from "@axel/pull-connectors";
import { BigQuery } from "@google-cloud/bigquery";
import { MongoClient, ObjectId } from "mongodb";
import pg from "pg";
import { pullPgSslOption } from "@axel/shared";
import { createSafePgStream, safeLookup } from "./safe-egress";

export type DbPullSourceType = "postgres" | "mongodb" | "bigquery";

export function isDbPullType(type: PullSourceType): type is DbPullSourceType {
  return type === "postgres" || type === "mongodb" || type === "bigquery";
}

/**
 * Build the @axel/pull-connectors connector for a database pull source,
 * wired with a sync-grade Node-driver connect factory. Throws for SaaS
 * types — those run through the dashboard's inline runGenericSync path.
 */
export function buildDbPullConnector(type: DbPullSourceType): PullConnector<Record<string, unknown>> {
  if (type === "postgres") {
    return createPostgresConnector({ connect: pgConnect }) as unknown as PullConnector<Record<string, unknown>>;
  }
  if (type === "mongodb") {
    return createMongodbConnector({ connect: mongoConnect }) as unknown as PullConnector<Record<string, unknown>>;
  }
  return createBigQueryConnector({ connect: bigqueryConnect }) as unknown as PullConnector<Record<string, unknown>>;
}

const pgConnect = async (config: PostgresConfig): Promise<PgClient> => {
  const pool = new pg.Pool({
    ...(config.connection_string
      ? { connectionString: config.connection_string }
      : {
          ...(config.host ? { host: config.host } : {}),
          ...(config.port ? { port: config.port } : {}),
          ...(config.database ? { database: config.database } : {}),
          ...(config.user ? { user: config.user } : {}),
          ...(config.password ? { password: config.password } : {}),
        }),
    stream: createSafePgStream,
    max: 2,
    // Verify the server certificate by default. A self-signed / private-CA DB
    // opts out with ssl:"no-verify" (or "disable" for no TLS). Matches pull-worker.
    ssl: pullPgSslOption(config),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (err) => {
    console.error("[pg-pull] async pool error:", err instanceof Error ? err.message : err);
  });
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as T[] };
    },
    async end() {
      await pool.end();
    },
  };
};

const mongoConnect = async (config: MongodbConfig): Promise<MongodbClientLike> => {
  const client = new MongoClient(config.uri, {
    maxPoolSize: 4,
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    lookup: safeLookup,
  });
  await client.connect();
  return {
    db(name: string) {
      const db = client.db(name);
      return {
        collection(collectionName: string) {
          const coll = db.collection(collectionName);
          return {
            find(filter: Record<string, unknown>) {
              return wrapCursor(coll.find(rehydrateCursors(filter)));
            },
            aggregate(pipeline: Array<Record<string, unknown>>) {
              return wrapCursor(coll.aggregate(pipeline.map(rehydrateCursors)));
            },
          };
        },
        async listCollections() {
          const docs = await db.listCollections({}, { nameOnly: true }).toArray();
          return docs.map((d: { name: string; type?: string }) => ({
            name: d.name,
            ...(d.type ? { type: d.type } : {}),
          }));
        },
      };
    },
    async close() {
      await client.close();
    },
  };
};

/**
 * Upgrade any 24-char hex string under a `$gt`/`$gte`/`$lt`/`$lte`/`$eq`
 * to a real ObjectId so the `_id` cursor predicate compares correctly
 * server-side. See the module header for why this is load-bearing.
 */
function rehydrateCursors<T>(input: T): T {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) {
    return input.map(rehydrateCursors) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      ["$gt", "$gte", "$lt", "$lte", "$eq"].includes(key) &&
      typeof value === "string" &&
      /^[0-9a-fA-F]{24}$/.test(value)
    ) {
      out[key] = new ObjectId(value);
    } else if (value !== null && typeof value === "object") {
      out[key] = rehydrateCursors(value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

interface DriverCursor {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): DriverCursor;
  limit(n: number): DriverCursor;
}

function wrapCursor(cursor: DriverCursor): {
  toArray(): Promise<Record<string, unknown>[]>;
  sort(spec: Record<string, 1 | -1>): ReturnType<typeof wrapCursor>;
  limit(n: number): ReturnType<typeof wrapCursor>;
} {
  return {
    toArray: () => cursor.toArray(),
    sort: (spec) => wrapCursor(cursor.sort(spec)),
    limit: (n) => wrapCursor(cursor.limit(n)),
  };
}

const bigqueryConnect = async (
  config: BigQueryConfig & Partial<BigQueryCredentials>,
): Promise<BigQueryClientLike> => {
  if (!config.service_account_json) {
    throw new Error("BigQuery pull source missing service_account_json credential.");
  }
  const credentials = JSON.parse(config.service_account_json);
  const bq = new BigQuery({
    projectId: config.project_id,
    credentials,
    ...(config.location ? { location: config.location } : {}),
  });
  return {
    async query({ sql, params, location, pageToken, maxResults }) {
      // BigQuery v8 bq.query returns [rows]. Pagination within a single
      // read() is not followed here; the per-tick page cap + cursor
      // watermark advance across syncs. Matches pull-worker.
      void pageToken;
      const [rows] = await bq.query({
        query: sql,
        params,
        ...(location ? { location } : {}),
        maxResults,
        useLegacySql: false,
      });
      return { rows: rows as Record<string, unknown>[] };
    },
  };
};
