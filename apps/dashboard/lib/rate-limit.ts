import "server-only";
import { db } from "./db";

/**
 * Fixed-window rate limiting for the auth surface (sign-in, sign-up, password
 * reset). The audit flagged that these had no brute-force protection and the
 * dashboard runs serverless on Vercel — so an in-memory limiter would reset on
 * every cold start and never share state across instances. This is therefore
 * Postgres-backed (a single atomic upsert per check), with an in-memory store
 * used only by tests.
 */

export interface RateLimitStore {
  /**
   * Record a hit for `key` and return the running count within the current
   * `windowMs` window (1 on a fresh or expired window). `now` is injectable for
   * the in-memory store; the Postgres store uses server time.
   */
  hit(key: string, windowMs: number, now: number): Promise<number>;
}

export interface RateLimitResult {
  ok: boolean;
  count: number;
  limit: number;
  retryAfterSeconds: number;
}

export async function checkRateLimit(
  store: RateLimitStore,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<RateLimitResult> {
  const count = await store.hit(key, windowMs, now);
  const ok = count <= limit;
  return { ok, count, limit, retryAfterSeconds: ok ? 0 : Math.ceil(windowMs / 1000) };
}

/** In-memory fixed-window store. Tests / single-process only. */
export function createMemoryRateLimitStore(): RateLimitStore & { reset(): void } {
  const windows = new Map<string, { start: number; count: number }>();
  return {
    async hit(key, windowMs, now) {
      const w = windows.get(key);
      if (!w || now - w.start >= windowMs) {
        windows.set(key, { start: now, count: 1 });
        return 1;
      }
      w.count += 1;
      return w.count;
    },
    reset() {
      windows.clear();
    },
  };
}

type QueryFn = (sql: string, params: unknown[]) => Promise<{ rows: Array<{ count: number }> }>;

/**
 * Postgres fixed-window store. The single statement is atomic: it inserts a
 * fresh window or, on conflict, resets the window when it has elapsed else
 * increments — so concurrent attempts can't race past the limit. Uses server
 * `now()` (ignores the injected clock) to avoid client skew.
 */
export function createPgRateLimitStore(query: QueryFn): RateLimitStore {
  return {
    async hit(key, windowMs, _now) {
      const res = await query(
        `INSERT INTO auth_rate_limits (bucket_key, window_start, count)
         VALUES ($1, now(), 1)
         ON CONFLICT (bucket_key) DO UPDATE SET
           count = CASE
             WHEN auth_rate_limits.window_start <= now() - ($2 || ' milliseconds')::interval
             THEN 1 ELSE auth_rate_limits.count + 1 END,
           window_start = CASE
             WHEN auth_rate_limits.window_start <= now() - ($2 || ' milliseconds')::interval
             THEN now() ELSE auth_rate_limits.window_start END
         RETURNING count`,
        [key, String(windowMs)],
      );
      return res.rows[0]?.count ?? 1;
    },
  };
}

/** A single rate-limit rule: bucket key, max hits, window. */
export type RateLimitRule = readonly [key: string, limit: number, windowMs: number];

/**
 * Apply several rules against a store and return the FIRST that is exceeded, or
 * null when all are within limits. Every rule is recorded (each is a real
 * attempt).
 *
 * FAIL-CLOSED: a store error returns a short synthetic breach. Authentication
 * and API-key validation use the same database, so continuing without this
 * control does not provide a dependable availability benefit. It does create
 * a brute-force and stolen-token bypass exactly when the control plane is
 * degraded.
 */
export async function checkRulesFailClosed(
  store: RateLimitStore,
  rules: readonly RateLimitRule[],
  now?: number,
): Promise<RateLimitResult | null> {
  try {
    let firstBreach: RateLimitResult | null = null;
    for (const [key, limit, windowMs] of rules) {
      const result = await checkRateLimit(store, key, limit, windowMs, now);
      if (!result.ok && !firstBreach) firstBreach = result;
    }
    return firstBreach;
  } catch {
    console.error("[rate-limit] check failed — blocking request");
    return {
      ok: false,
      count: 1,
      limit: 0,
      retryAfterSeconds: 60,
    };
  }
}

/** Production entrypoint: enforce auth rules against the Postgres store. */
export async function enforceAuthRateLimits(rules: readonly RateLimitRule[]): Promise<RateLimitResult | null> {
  const store = createPgRateLimitStore((sql, params) => db().query(sql, params) as Promise<{ rows: Array<{ count: number }> }>);
  return checkRulesFailClosed(store, rules);
}

export function rateLimitMessage(result: RateLimitResult): string {
  const mins = Math.ceil(result.retryAfterSeconds / 60);
  return `Too many attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
}
