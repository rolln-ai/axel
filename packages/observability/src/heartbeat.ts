/**
 * Component heartbeats — each worker calls one of these per tick so
 * the admin/status pages can detect a wedged loop. `/health`
 * endpoints only prove the process is up; the heartbeat row
 * (last_seen + monotonic tick count) proves the work loop is making
 * forward progress.
 *
 * Two flavours:
 *
 *   - `recordHeartbeat(pool, …)` for Node services that already
 *     have a `pg.Pool` (delivery-service, pull-worker, future
 *     Node-side workers).
 *
 *   - `recordHeartbeatHttp(url, secret, …)` for Cloudflare Workers
 *     (ingest, router-edge) that can't hold a PG connection.
 *     They POST to delivery-service's `/internal/heartbeat`
 *     endpoint with the shared secret.
 *
 * Both are best-effort: errors are caught + logged, never thrown.
 * A failed heartbeat must not crash the work loop that should be
 * running.
 */

export interface HeartbeatInput {
  component: string;
  /** Monotonic counter since process boot. Helps catch a loop that's
   *  spinning fast enough to keep `last_seen` fresh but isn't making
   *  forward progress (e.g. it's in a tight retry loop on the same
   *  message). */
  tickCount?: number;
  /** Most recent non-fatal error the worker observed on its tick. */
  error?: string;
  /** Free-form metadata (queue lag, last-processed event id, etc.). */
  metadata?: Record<string, unknown>;
  /** Expected seconds between heartbeats. Used for red/yellow/green
   *  badge. Defaults to 60s for most workers; pull-worker sets ~90s. */
  expectedIntervalSeconds?: number;
  environment?: string;
}

interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

export async function recordHeartbeat(
  pool: PgPoolLike,
  input: HeartbeatInput,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO component_heartbeats
         (component, environment, last_seen, last_tick_count, last_error, metadata, expected_interval_seconds)
       VALUES ($1, $2, now(), $3, $4, $5::jsonb, $6)
       ON CONFLICT (component) DO UPDATE
         SET last_seen = now(),
             environment = COALESCE(EXCLUDED.environment, component_heartbeats.environment),
             last_tick_count = EXCLUDED.last_tick_count,
             last_error = EXCLUDED.last_error,
             metadata = EXCLUDED.metadata,
             expected_interval_seconds = EXCLUDED.expected_interval_seconds`,
      [
        input.component,
        input.environment ?? null,
        input.tickCount ?? 0,
        input.error ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.expectedIntervalSeconds ?? 60,
      ],
    );
  } catch (err) {
    // Heartbeat failure must never crash the loop it's reporting on.
    // Log once per tick and let the next tick try again.
    console.error("[heartbeat] write failed", err);
  }
}

export interface HeartbeatHttpOptions {
  fetchImpl?: typeof fetch;
}

export async function recordHeartbeatHttp(
  url: string,
  sharedSecret: string,
  input: HeartbeatInput,
  options: HeartbeatHttpOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axel-shared-secret": sharedSecret,
      },
      body: JSON.stringify(input),
    });
    if (!response.ok) {
      console.warn(`[heartbeat] HTTP ${response.status} for ${input.component}`);
    }
  } catch (err) {
    console.error("[heartbeat] http post failed", err);
  }
}
