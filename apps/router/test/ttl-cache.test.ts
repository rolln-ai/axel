import { describe, expect, it } from "vitest";
import { createTtlCache } from "@axel/shared";

describe("createTtlCache", () => {
  it("serves from cache within the TTL (loads once)", async () => {
    let now = 1000;
    let loads = 0;
    const cache = createTtlCache<number>({ ttlMs: 100, now: () => now });
    const load = () => {
      loads += 1;
      return Promise.resolve(42);
    };
    expect(await cache.getOrLoad("k", load)).toBe(42);
    now = 1050; // still within TTL
    expect(await cache.getOrLoad("k", load)).toBe(42);
    expect(loads).toBe(1);
  });

  it("reloads after the TTL expires", async () => {
    let now = 0;
    let loads = 0;
    const cache = createTtlCache<number>({ ttlMs: 100, now: () => now });
    const load = () => {
      loads += 1;
      return Promise.resolve(loads);
    };
    expect(await cache.getOrLoad("k", load)).toBe(1);
    now = 101; // past TTL
    expect(await cache.getOrLoad("k", load)).toBe(2);
    expect(loads).toBe(2);
  });

  it("shares a single in-flight load for concurrent callers", async () => {
    let loads = 0;
    let resolve!: (v: number) => void;
    const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 0 });
    const load = () => {
      loads += 1;
      return new Promise<number>((r) => {
        resolve = r;
      });
    };
    const a = cache.getOrLoad("k", load);
    const b = cache.getOrLoad("k", load);
    resolve(7);
    expect(await a).toBe(7);
    expect(await b).toBe(7);
    expect(loads).toBe(1);
  });

  it("evicts a rejected load so the next call retries", async () => {
    let loads = 0;
    const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 0 });
    await expect(
      cache.getOrLoad("k", () => {
        loads += 1;
        return Promise.reject(new Error("boom"));
      }),
    ).rejects.toThrow("boom");
    await Promise.resolve(); // flush the eviction microtask
    expect(
      await cache.getOrLoad("k", () => {
        loads += 1;
        return Promise.resolve(9);
      }),
    ).toBe(9);
    expect(loads).toBe(2);
  });

  it("invalidate(key) forces a reload", async () => {
    let loads = 0;
    const cache = createTtlCache<number>({ ttlMs: 1000, now: () => 0 });
    const load = () => {
      loads += 1;
      return Promise.resolve(loads);
    };
    expect(await cache.getOrLoad("k", load)).toBe(1);
    cache.invalidate("k");
    expect(await cache.getOrLoad("k", load)).toBe(2);
  });

  it("ttlMs <= 0 disables caching (loads every time)", async () => {
    let loads = 0;
    const cache = createTtlCache<number>({ ttlMs: 0, now: () => 0 });
    const load = () => {
      loads += 1;
      return Promise.resolve(loads);
    };
    await cache.getOrLoad("k", load);
    await cache.getOrLoad("k", load);
    expect(loads).toBe(2);
  });

  it("tracks hit/miss stats", async () => {
    const cache = createTtlCache<number>({ ttlMs: 100, now: () => 0 });
    const load = () => Promise.resolve(1);
    await cache.getOrLoad("k", load); // miss
    await cache.getOrLoad("k", load); // hit
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });
});
