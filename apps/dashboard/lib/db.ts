import "server-only";
import pg from "pg";
import { controlPlanePgSslOption } from "@axel/shared";
import { isPoolAcquireTimeout, isTransientPostgresError } from "@axel/observability";

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
      ssl: controlPlanePgSslOption(
        process.env.DATABASE_URL,
        process.env.CONTROL_PLANE_DB_SSL_VERIFY,
      ),
      max: poolMax,
      maxUses: Number.parseInt(process.env.DATABASE_POOL_MAX_USES ?? (IS_VERCEL ? "50" : "20"), 10),
      // Render's external Postgres handshake can be slow from Vercel, so keep
      // serverless sockets warm longer there. Non-Vercel hosts recycle faster
      // to avoid inheriting dead idle connections after managed-DB restarts.
      idleTimeoutMillis: IS_VERCEL ? 120_000 : 10_000,
      connectionTimeoutMillis: IS_VERCEL ? 30_000 : 8_000,
      keepAlive: true,
    });
    pool.on("error", () => {
      // pg auto-evicts the failing client; this listener just prevents the
      // unhandled 'error' event from crashing the worker.
      console.error("[db] idle client error");
    });
    // Retry only connection acquisition, before pg sends any SQL. Retrying
    // pool.query after a lost response could repeat an already-committed write.
    // Preserve both connect overloads: pg's own pool.query uses the callback
    // form, while transactions use the Promise form.
    const originalConnect = pool.connect.bind(pool);
    const acquire = async (): Promise<pg.PoolClient> => {
      for (let attempt = 0; attempt < TRANSIENT_CONNECT_ATTEMPTS; attempt++) {
        try {
          return await originalConnect();
        } catch (err) {
          if (isPoolAcquireTimeout(err) || !isTransientPostgresError(err) || attempt === TRANSIENT_CONNECT_ATTEMPTS - 1) {
            throw err;
          }
          await sleep(transientBackoffMs(attempt));
        }
      }
      throw new Error("unreachable connect retry state");
    };
    pool.connect = ((callback?: (err: Error | undefined, client?: pg.PoolClient, release?: pg.PoolClient["release"]) => void) => {
      const connection = acquire();
      if (!callback) return connection;
      void connection.then(
        (client) => callback(undefined, client, client.release),
        (err) => callback(err),
      );
    }) as pg.Pool["connect"];
    globalThis.__axelDashboardPoolV2 = pool;
  }
  return globalThis.__axelDashboardPoolV2;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  let discard = false;
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original failure and evict a client whose transaction state
      // could not be cleared. Never return it to another request.
      discard = true;
    }
    throw err;
  } finally {
    client.release(discard);
  }
}
