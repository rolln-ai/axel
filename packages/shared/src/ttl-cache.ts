/**
 * Generic in-process TTL cache with single-flight loading.
 *
 * Motivating use: router-edge route lookups. router-edge already deduped
 * lookups WITHIN a single queue batch (one Map per batch), but every new batch
 * started cold and hit delivery-service `/internal/routes` again — observed as
 * ~46% "timeout when trying to connect" against the shared PG pool under load.
 * A warm Cloudflare isolate persists module-level state across invocations, so
 * a module-level TTL cache lets consecutive batches for the same key reuse a
 * lookup for `ttlMs` (default 30s) — the strategy the (never-deployed, since
 * removed) apps/router CachedRouteStore used.
 *
 * Properties:
 * - Single-flight: concurrent loads for one key share a Promise.
 * - A rejected load is evicted immediately, so a transient upstream error is
 *   not cached for the whole TTL.
 * - FIFO eviction at `maxEntries`.
 * - Tradeoff: cached values are up to `ttlMs` stale; `invalidate()` is exposed
 *   for an explicit purge channel.
 */

interface TtlEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

export interface TtlCacheOptions {
  /** Entry lifetime in ms. Default 30_000. `<= 0` disables caching (always loads). */
  ttlMs?: number;
  /** FIFO eviction cap. Default 1024. */
  maxEntries?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export interface TtlCache<T> {
  getOrLoad(key: string, load: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  invalidateAll(): void;
  stats(): { entries: number; hits: number; misses: number };
}

export function createTtlCache<T>(options: TtlCacheOptions = {}): TtlCache<T> {
  const ttlMs = options.ttlMs ?? 30_000;
  const maxEntries = options.maxEntries ?? 1024;
  const now = options.now ?? (() => Date.now());
  const map = new Map<string, TtlEntry<T>>();
  let hits = 0;
  let misses = 0;

  function getOrLoad(key: string, load: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const existing = map.get(key);
      if (existing && existing.expiresAt > now()) {
        hits += 1;
        return existing.promise;
      }
    }
    misses += 1;
    const promise = load();
    if (ttlMs > 0) {
      // Don't cache a rejected load — evict so the next caller retries.
      promise.catch(() => {
        const entry = map.get(key);
        if (entry && entry.promise === promise) map.delete(key);
      });
      map.set(key, { expiresAt: now() + ttlMs, promise });
      if (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest !== undefined) map.delete(oldest);
      }
    }
    return promise;
  }

  return {
    getOrLoad,
    invalidate(key) {
      map.delete(key);
    },
    invalidateAll() {
      map.clear();
    },
    stats() {
      return { entries: map.size, hits, misses };
    },
  };
}
