/**
 * A session-scoped PostgreSQL advisory lock shared by every pull execution
 * surface. Holding a dedicated client for the lease makes dashboard "Sync now"
 * and the background worker mutually exclusive without adding mutable lock
 * columns or leaving stale claims behind after a process dies.
 */

export interface PullSourceLockLease {
  client: PullSourceLockClient;
  release(): Promise<void>;
}

export interface PullSourceLockClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

export interface AdvisoryLockPool {
  // `unknown` deliberately keeps this package independent of `pg`; a pg.Pool
  // satisfies the contract and the runtime client is narrowed below.
  connect(): Promise<unknown>;
}

const LOCK_NAMESPACE = "axel.pull_source_sync";

export async function tryAcquirePullSourceLock(
  pool: AdvisoryLockPool,
  sourceId: string,
): Promise<PullSourceLockLease | null> {
  const client = await pool.connect() as PullSourceLockClient;
  let handedOff = false;
  try {
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS acquired",
      [LOCK_NAMESPACE, sourceId],
    );
    if (result.rows[0]?.acquired !== true) return null;

    handedOff = true;
    let released = false;
    return {
      client,
      async release() {
        if (released) return;
        released = true;
        try {
          await client.query(
            "SELECT pg_advisory_unlock(hashtext($1), hashtext($2))",
            [LOCK_NAMESPACE, sourceId],
          );
        } finally {
          client.release();
        }
      },
    };
  } finally {
    // A failed try-lock still checked out a client. Return it immediately; an
    // acquired client is intentionally retained until the lease releases it.
    if (!handedOff) client.release();
  }
}
