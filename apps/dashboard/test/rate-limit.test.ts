import { describe, expect, it, vi } from "vitest";
import {
  checkRateLimit,
  checkRulesFailClosed,
  createMemoryRateLimitStore,
  createPgRateLimitStore,
  type RateLimitStore,
} from "../lib/rate-limit";

describe("rate-limit", () => {
  describe("memory store (fixed window)", () => {
    it("counts within a window and resets after it elapses", async () => {
      const store = createMemoryRateLimitStore();
      expect(await store.hit("k", 1000, 0)).toBe(1);
      expect(await store.hit("k", 1000, 500)).toBe(2);
      expect(await store.hit("k", 1000, 999)).toBe(3);
      expect(await store.hit("k", 1000, 1000)).toBe(1); // window elapsed -> reset
      expect(await store.hit("k", 1000, 1200)).toBe(2);
    });

    it("tracks keys independently", async () => {
      const store = createMemoryRateLimitStore();
      expect(await store.hit("a", 1000, 0)).toBe(1);
      expect(await store.hit("b", 1000, 0)).toBe(1);
      expect(await store.hit("a", 1000, 100)).toBe(2);
    });
  });

  describe("checkRateLimit", () => {
    it("is ok up to the limit, then blocks with a retry hint", async () => {
      const store = createMemoryRateLimitStore();
      expect((await checkRateLimit(store, "k", 2, 60_000, 0)).ok).toBe(true); // count 1
      expect((await checkRateLimit(store, "k", 2, 60_000, 0)).ok).toBe(true); // count 2
      const third = await checkRateLimit(store, "k", 2, 60_000, 0); // count 3
      expect(third.ok).toBe(false);
      expect(third.count).toBe(3);
      expect(third.retryAfterSeconds).toBe(60);
    });
  });

  describe("checkRulesFailClosed", () => {
    it("returns the first breached rule", async () => {
      const store = createMemoryRateLimitStore();
      expect(await checkRulesFailClosed(store, [["k", 1, 60_000]], 0)).toBeNull(); // count 1, ok
      const breach = await checkRulesFailClosed(store, [["k", 1, 60_000]], 0); // count 2, over
      expect(breach?.ok).toBe(false);
    });

    it("fails closed without logging the store exception", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const throwingStore: RateLimitStore = {
        async hit() {
          throw new Error(
            "relation auth_rate_limits does not exist for victim@example.test",
          );
        },
      };
      await expect(
        checkRulesFailClosed(throwingStore, [["k", 1, 60_000]], 0),
      ).resolves.toEqual({
        ok: false,
        count: 1,
        limit: 0,
        retryAfterSeconds: 60,
      });
      expect(spy).toHaveBeenCalledWith(
        "[rate-limit] check failed — blocking request",
      );
      expect(JSON.stringify(spy.mock.calls)).not.toContain(
        "victim@example.test",
      );
      spy.mockRestore();
    });
  });

  describe("pg store", () => {
    it("issues one atomic upsert and returns the running count", async () => {
      const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [{ count: 4 }] }));
      const store = createPgRateLimitStore(query);
      expect(await store.hit("signin:ip:1.2.3.4", 900_000, Date.now())).toBe(4);
      const [sql, params] = query.mock.calls[0]!;
      expect(sql).toMatch(/INSERT INTO auth_rate_limits/);
      expect(sql).toMatch(/ON CONFLICT \(bucket_key\) DO UPDATE/);
      expect(params).toEqual(["signin:ip:1.2.3.4", "900000"]);
    });
  });
});
