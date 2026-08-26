import "server-only";
import pg from "pg";
import { controlPlaneDbSslVerify } from "@axel/shared";
import { isTransientPostgresError } from "@axel/observability";

const { Pool } = pg;

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

declare global {
  // eslint-disable-next-line no-var
  var __axelDashboardPoolV2: pg.Pool | undefined;
}

export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function transientBackoffMs(attempt: number): number {
  return Math.min(2_000, 250 * 2 ** attempt);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const IS_VERCEL = Boolean(process.env.VERCEL);
const TRANSIENT_QUERY_ATTEMPTS = IS_VERCEL ? 2 : 8;
const TRANSIENT_CONNECT_ATTEMPTS = IS_VERCEL ? 2 : 8;

export function db(): pg.Pool {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Axel dashboard auth and workspace data.");
  }
  if (!globalThis.__axelDashboardPoolV2) {
    const configuredPoolMax = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "20", 10);
    const poolMax = IS_VERCEL ? Math.min(configuredPoolMax, 2) : configuredPoolMax;
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("localhost")
        ? false
        : { rejectUnauthorized: controlPlaneDbSslVerify(process.env.CONTROL_PLANE_DB_SSL_VERIFY) },
      max: poolMax,
      maxUses: Number.parseInt(process.env.DATABASE_POOL_MAX_USES ?? (IS_VERCEL ? "50" : "20"), 10),
      // Render's external Postgres handshake can be slow from Vercel, so keep
      // serverless sockets warm longer there. Non-Vercel hosts recycle faster
      // to avoid inheriting dead idle connections after managed-DB restarts.
      idleTimeoutMillis: IS_VERCEL ? 120_000 : 10_000,
      connectionTimeoutMillis: IS_VERCEL ? 30_000 : 8_000,
      keepAlive: true,
    });
    pool.on("error", (err) => {
      // pg auto-evicts the failing client; this listener just prevents the
      // unhandled 'error' event from crashing the worker.
      console.error("[db] idle client error:", err);
    });
    // Wrap pool.query with bounded retries on transient connection errors.
    // When a Vercel function instance resumes from suspension, sockets in the
    // pool may already be dead; during Supabase pooler restarts, fresh dials can
    // also fail briefly. pg evicts bad clients, so a short retry loop lets the
    // next attempt pull a healthy connection instead of surfacing a route error.
    const originalQuery = pool.query.bind(pool) as pg.Pool["query"];
    pool.query = (async (...args: unknown[]) => {
      for (let attempt = 0; attempt < TRANSIENT_QUERY_ATTEMPTS; attempt++) {
        try {
          return await (originalQuery as (...a: unknown[]) => Promise<unknown>)(...args);
        } catch (err) {
          if (!isTransientPostgresError(err) || attempt === TRANSIENT_QUERY_ATTEMPTS - 1) {
            throw err;
          }
          await sleep(transientBackoffMs(attempt));
        }
      }
      throw new Error("unreachable query retry state");
    }) as pg.Pool["query"];
    globalThis.__axelDashboardPoolV2 = pool;
  }
  return globalThis.__axelDashboardPoolV2;
}

async function connectWithRetry(): Promise<pg.PoolClient> {
  for (let attempt = 0; attempt < TRANSIENT_CONNECT_ATTEMPTS; attempt++) {
    try {
      return await db().connect();
    } catch (err) {
      if (!isTransientPostgresError(err) || attempt === TRANSIENT_CONNECT_ATTEMPTS - 1) {
        throw err;
      }
      await sleep(transientBackoffMs(attempt));
    }
  }
  throw new Error("unreachable connect retry state");
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await connectWithRetry();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
