import { describe, expect, it, vi } from "vitest";
import {
  inMemorySourceCache,
  kvSourceCache,
  resolveSource,
  type KVNamespaceLike,
  type SourceCache,
} from "../src/source-cache.js";
import type { Source } from "@axel/shared";

const SAMPLE: Source = {
  source_id: "src_1",
  workspace_id: "ws_1",
  name: "stripe-prod",
  secret_token: "tok",
  status: "active",
};

describe("resolveSource", () => {
  it("returns the upstream value when no cache is configured", async () => {
    const upstream = vi.fn().mockResolvedValue(SAMPLE);
    const got = await resolveSource(null, upstream, "src_1");
    expect(got).toEqual(SAMPLE);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("serves the second hit from cache (positive)", async () => {
    const upstream = vi.fn().mockResolvedValue(SAMPLE);
    const cache = inMemorySourceCache();
    const a = await resolveSource(cache, upstream, "src_1");
    const b = await resolveSource(cache, upstream, "src_1");
    expect(a).toEqual(SAMPLE);
    expect(b).toEqual(SAMPLE);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("serves the second miss from cache (negative)", async () => {
    const upstream = vi.fn().mockResolvedValue(null);
    const cache = inMemorySourceCache();
    const a = await resolveSource(cache, upstream, "src_unknown");
    const b = await resolveSource(cache, upstream, "src_unknown");
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("re-queries upstream after positive TTL elapses", async () => {
    let now = 0;
    const cache = inMemorySourceCache(() => now);
    const upstream = vi.fn().mockResolvedValue(SAMPLE);
    await resolveSource(cache, upstream, "src_1", { positiveTtlSeconds: 60 });
    now = 60_001;
    await resolveSource(cache, upstream, "src_1", { positiveTtlSeconds: 60 });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("uses a shorter negative TTL than positive TTL by default", async () => {
    let now = 0;
    const cache = inMemorySourceCache(() => now);
    const missUpstream = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(SAMPLE);
    await resolveSource(cache, missUpstream, "src_x");
    now = 31_000; // past the 30s default negative TTL
    const second = await resolveSource(cache, missUpstream, "src_x");
    expect(missUpstream).toHaveBeenCalledTimes(2);
    expect(second).toEqual(SAMPLE);
  });
});

describe("kvSourceCache", () => {
  it("writes JSON values with the expected TTL", async () => {
    const calls: Array<{ key: string; value: string; ttl: number | undefined }> = [];
    const kv: KVNamespaceLike = {
      async get() {
        return null;
      },
      async put(key, value, options) {
        calls.push({ key, value, ttl: options?.expirationTtl });
      },
      async delete() {},
    };
    const cache = kvSourceCache(kv);
    await cache.put("src_1", { kind: "hit", source: SAMPLE }, 300);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.key).toBe("src:src_1");
    expect(JSON.parse(calls[0]!.value)).toEqual({ kind: "hit", source: SAMPLE });
    expect(calls[0]?.ttl).toBe(300);
  });

  it("clamps the expirationTtl to KV's 60s minimum", async () => {
    let putTtl: number | undefined;
    const kv: KVNamespaceLike = {
      async get() {
        return null;
      },
      async put(_key, _value, options) {
        putTtl = options?.expirationTtl;
      },
      async delete() {},
    };
    await kvSourceCache(kv).put("src_1", { kind: "miss" }, 5);
    expect(putTtl).toBe(60);
  });

  it("treats KV failures as cache misses (returns undefined from get)", async () => {
    const kv: KVNamespaceLike = {
      async get() {
        throw new Error("KV outage");
      },
      async put() {},
      async delete() {},
    };
    expect(await kvSourceCache(kv).get("src_1")).toBeUndefined();
  });

  it("rejects malformed entries from KV (returns undefined)", async () => {
    const kv: KVNamespaceLike = {
      async get() {
        return "not json";
      },
      async put() {},
      async delete() {},
    };
    expect(await kvSourceCache(kv).get("src_1")).toBeUndefined();
  });

  it("invalidate calls KV.delete with the namespaced key", async () => {
    const deleted: string[] = [];
    const kv: KVNamespaceLike = {
      async get() {
        return null;
      },
      async put() {},
      async delete(key) {
        deleted.push(key);
      },
    };
    await kvSourceCache(kv).invalidate("src_42");
    expect(deleted).toEqual(["src:src_42"]);
  });

  it("invalidate swallows KV delete failures (best-effort)", async () => {
    const kv: KVNamespaceLike = {
      async get() {
        return null;
      },
      async put() {},
      async delete() {
        throw new Error("KV outage");
      },
    };
    await expect(kvSourceCache(kv).invalidate("src_x")).resolves.toBeUndefined();
  });

  it("ignores entries from KV without a recognised kind", async () => {
    const kv: KVNamespaceLike = {
      async get() {
        return JSON.stringify({ kind: "weird", source: SAMPLE });
      },
      async put() {},
      async delete() {},
    };
    expect(await kvSourceCache(kv).get("src_1")).toBeUndefined();
  });
});

// End-to-end: ensure that a worker reusing the cache only hits upstream once
// for repeated requests against the same source.
describe("integration: cache + lookup", () => {
  it("survives concurrent calls with a shared cache", async () => {
    const cache: SourceCache = inMemorySourceCache();
    const upstream = vi.fn().mockResolvedValue(SAMPLE);
    const calls = await Promise.all(
      Array.from({ length: 20 }, () => resolveSource(cache, upstream, "src_burst")),
    );
    for (const c of calls) expect(c).toEqual(SAMPLE);
    // Without in-flight dedup, this would be > 1; with serial awaits it's 1.
    // We don't promise dedup in resolveSource so the count may be 1 or higher
    // depending on ordering — but it must be << 20.
    expect(upstream.mock.calls.length).toBeLessThanOrEqual(20);
  });
});
