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
  /** Stable low-cardinality error code for the most recent failed tick. */
  error?: string;
  /** Numeric/boolean operational metrics only; string values are discarded. */
  metadata?: Record<string, unknown>;
  /** Expected seconds between heartbeats. Used for red/yellow/green
   *  badge. Defaults to 60s for most workers; pull-worker sets ~90s. */
  expectedIntervalSeconds?: number;
  environment?: string;
}

interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

const SAFE_HEARTBEAT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function safeHeartbeatSlug(value: unknown, fallback: string): string {
  return typeof value === "string" && SAFE_HEARTBEAT_SLUG_RE.test(value) ? value : fallback;
}

function safeHeartbeatMetadata(
  input: Record<string, unknown> | undefined,
  depth = 0,
): Record<string, unknown> {
  if (!input || depth >= 3) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (!SAFE_HEARTBEAT_SLUG_RE.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "object" && value && !Array.isArray(value)) {
      const nested = safeHeartbeatMetadata(value as Record<string, unknown>, depth + 1);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}

export function sanitizeHeartbeatInput(input: HeartbeatInput): HeartbeatInput {
  const tickCount =
    typeof input.tickCount === "number" && Number.isSafeInteger(input.tickCount) && input.tickCount >= 0
      ? input.tickCount
      : 0;
  const expectedIntervalSeconds =
    typeof input.expectedIntervalSeconds === "number" &&
    Number.isFinite(input.expectedIntervalSeconds) &&
    input.expectedIntervalSeconds > 0
      ? Math.min(86_400, Math.floor(input.expectedIntervalSeconds))
      : 60;
  const error = input.error
    ? safeHeartbeatSlug(input.error, "operation_failed")
    : undefined;
  const environment = input.environment
    ? safeHeartbeatSlug(input.environment, "unknown")
    : undefined;
  return {
    component: safeHeartbeatSlug(input.component, "unknown-component"),
    tickCount,
    ...(error ? { error } : {}),
    metadata: safeHeartbeatMetadata(input.metadata),
    expectedIntervalSeconds,
    ...(environment ? { environment } : {}),
  };
}

export async function recordHeartbeat(
  pool: PgPoolLike,
  input: HeartbeatInput,
): Promise<void> {
  try {
    const safeInput = sanitizeHeartbeatInput(input);
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
        safeInput.component,
        safeInput.environment ?? null,
        safeInput.tickCount ?? 0,
        safeInput.error ?? null,
        JSON.stringify(safeInput.metadata ?? {}),
        safeInput.expectedIntervalSeconds ?? 60,
      ],
    );
  } catch {
    // Heartbeat failure must never crash the loop it's reporting on.
    // Log once per tick and let the next tick try again.
    console.error("[heartbeat] write failed");
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
  const safeInput = sanitizeHeartbeatInput(input);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-axel-shared-secret": sharedSecret,
      },
      body: JSON.stringify(safeInput),
    });
    if (!response.ok) {
      console.warn(`[heartbeat] HTTP ${response.status} for ${safeInput.component}`);
    }
  } catch {
    console.error("[heartbeat] http post failed");
  }
}
