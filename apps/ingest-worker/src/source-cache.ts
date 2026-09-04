import type { Source } from "@axel/shared";

/**
 * Legacy KV source cache retained for rollback cleanup and compatibility with
 * the old admin routes. The ingest authorization path does not call
 * `resolveSource` or trust `src:*` entries. Hosted authorization uses the
 * per-source Durable Object; self-host authorization calls the authenticated
 * delivery-service origin on every request.
 */

export interface SourceCacheLookup {
  (sourceId: string): Promise<Source | null>;
}

export interface SourceCache {
  get(sourceId: string): Promise<CachedLookup | undefined>;
  put(sourceId: string, value: CachedLookup, ttlSeconds: number): Promise<void>;
  /**
   * Drop the cached entry for a single source, regardless of TTL. Called from
   * the admin invalidation endpoint when the control plane mutates a source
   * (token rotated, disabled, deleted) and must prove the stale entry is gone.
   */
  invalidate(sourceId: string): Promise<void>;
}

export type CachedLookup =
  | { kind: "hit"; source: Source }
  | { kind: "miss" };

export interface ResolveSourceOptions {
  /** Cache TTL for found sources (default 300s = 5 min). */
  positiveTtlSeconds?: number;
  /** Cache TTL for unknown sources (default 30s). */
  negativeTtlSeconds?: number;
}

/**
 * Legacy resolver kept for isolated tests and rollback tooling. Do not use it
 * for webhook authorization.
 */
export async function resolveSource(
  cache: SourceCache | null,
  lookup: SourceCacheLookup,
  sourceId: string,
  options: ResolveSourceOptions = {},
): Promise<Source | null> {
  const positiveTtl = options.positiveTtlSeconds ?? 300;
  const negativeTtl = options.negativeTtlSeconds ?? 30;

  if (cache) {
    const cached = await cache.get(sourceId);
    if (cached) {
      return cached.kind === "hit" ? cached.source : null;
    }
  }

  const fresh = await lookup(sourceId);

  if (cache) {
    if (fresh) {
      await cache.put(sourceId, { kind: "hit", source: fresh }, positiveTtl);
    } else {
      await cache.put(sourceId, { kind: "miss" }, negativeTtl);
    }
  }

  return fresh;
}

/**
 * Wrap a Cloudflare KV namespace into a `SourceCache`. Only misses are stored
 * as compact JSON; positive writes delete any historic secret-bearing value.
 * KV's minimum TTL is 60s, so negative TTLs are clamped accordingly.
 *
 * Reads and writes tolerate KV being unavailable. Deletes propagate errors so
 * a fence request also proves rollback state no longer contains the old row.
 */
export interface KVNamespaceLike {
  get(key: string, type?: "text" | "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function kvSourceCache(kv: KVNamespaceLike): SourceCache {
  return {
    async get(sourceId) {
      try {
        const raw = await kv.get(`src:${sourceId}`, "text");
        if (typeof raw !== "string") return undefined;
        const parsed = JSON.parse(raw) as CachedLookup;
        if (parsed.kind === "miss") return parsed;
        // Historic positive entries may contain secret-bearing source config.
        // They are deliberately unreadable in the current adapter.
        return undefined;
      } catch {
        // KV miss / KV down / corrupted entry: behave like an empty cache
        // so the caller falls through to upstream lookup.
        return undefined;
      }
    },
    async put(sourceId, value, ttlSeconds) {
      try {
        if (value.kind === "hit") {
          // Remove a historic value instead of persisting source credentials.
          await kv.delete(`src:${sourceId}`);
          return;
        }
        await kv.put(`src:${sourceId}`, JSON.stringify(value), {
          expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
        });
      } catch {
        // Best-effort write; missing the cache write only costs us one extra
        // upstream lookup on the next hit.
      }
    },
    async invalidate(sourceId) {
      await kv.delete(`src:${sourceId}`);
    },
  };
}

/** In-memory cache for tests and local dev. Honours TTL via an injectable clock. */
export function inMemorySourceCache(now: () => number = Date.now): SourceCache & {
  size(): number;
  drop(sourceId: string): void;
} {
  const store = new Map<string, { value: CachedLookup; expiresAt: number }>();

  return {
    async get(sourceId) {
      const entry = store.get(sourceId);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        store.delete(sourceId);
        return undefined;
      }
      return entry.value;
    },
    async put(sourceId, value, ttlSeconds) {
      store.set(sourceId, { value, expiresAt: now() + ttlSeconds * 1000 });
    },
    async invalidate(sourceId) {
      store.delete(sourceId);
    },
    size() {
      return store.size;
    },
    drop(sourceId) {
      store.delete(sourceId);
    },
  };
}
