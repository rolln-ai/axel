import type { Source } from "@axel/shared";

/**
 * Edge cache for source lookups.
 *
 * The hot path of the ingest worker resolves a source on every request to
 * validate the token, check status, and read per-source caps. Without an
 * edge cache, that's a Postgres round-trip per accepted webhook — even at
 * 5M events/month that's wasteful, and at higher volumes it pins the
 * control-plane DB.
 *
 * Strategy:
 * - **Positive cache** (5 min TTL by default): if we found a source, store
 *   it. Next request hits KV (1ms p99) instead of Postgres (10–50ms p99).
 * - **Negative cache** (30s TTL): if we did NOT find a source, store a
 *   sentinel so an attacker spamming unknown source IDs can't burn DB
 *   capacity. Short TTL so legitimate source creation is still visible
 *   within ~30s without an explicit invalidation.
 *
 * Invalidation:
 * - Token rotation and source disable propagate within `positiveTtlSeconds`
 *   (5 minutes by default). For faster propagation, the control plane can
 *   POST `/admin/source-cache/invalidate` (TODO future). The TTL gives us
 *   eventual consistency without coordination today.
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
   * (token rotated, status flipped, deleted) and wants the change to land at
   * the edge faster than `positiveTtlSeconds`.
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
 * Resolve a source through the optional cache. If `cache` is null (e.g. no
 * KV binding configured), the lookup runs every call and the function is
 * indistinguishable from calling `lookup` directly.
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
 * Wrap a Cloudflare KV namespace into a `SourceCache`. Values are stored as
 * compact JSON; KV's minimum TTL is 60s so we clamp negative TTLs accordingly.
 *
 * The implementation tolerates KV being temporarily unavailable: any thrown
 * error is treated as a cache miss and the upstream lookup is invoked.
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
        if (parsed.kind !== "hit" && parsed.kind !== "miss") return undefined;
        return parsed;
      } catch {
        // KV miss / KV down / corrupted entry: behave like an empty cache
        // so the caller falls through to upstream lookup.
        return undefined;
      }
    },
    async put(sourceId, value, ttlSeconds) {
      try {
        await kv.put(`src:${sourceId}`, JSON.stringify(value), {
          expirationTtl: Math.max(60, Math.floor(ttlSeconds)),
        });
      } catch {
        // Best-effort write; missing the cache write only costs us one extra
        // upstream lookup on the next hit.
      }
    },
    async invalidate(sourceId) {
      try {
        await kv.delete(`src:${sourceId}`);
      } catch {
        // If the delete fails, the cached entry will TTL out within
        // `positiveTtlSeconds`. Worst-case latency, never wrong correctness.
      }
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
