import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import worker, { type Env } from "../src/index.js";
import type { QueueMessage } from "@axel/shared";
import { resetRateLimitsForTests } from "../src/rate-limit.js";
import { inMemoryPlanCache } from "../src/plan-cache.js";

function tokenHash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

class FakeR2 {
  store = new Map<string, { body: ArrayBuffer; meta: Record<string, string> }>();
  async put(key: string, value: ArrayBuffer, options?: R2PutOptions): Promise<R2Object> {
    this.store.set(key, { body: value, meta: options?.customMetadata ?? {} });
    return { key } as unknown as R2Object;
  }
}
class FakeQueue<T> {
  sent: T[] = [];
  async send(msg: T): Promise<void> {
    this.sent.push(msg);
  }
}

function makeEnv(devSources: Record<string, unknown>): Env {
  const queues = Array.from({ length: 16 }, () => new FakeQueue<QueueMessage>());
  const r2 = new FakeR2() as unknown as R2Bucket;
  const env = {
    EVENTS_RAW: r2,
    DEV_MODE: "true",
    DEV_SOURCES: JSON.stringify(devSources),
  } as unknown as Env;
  for (let i = 0; i < 16; i++) {
    const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
    (env as unknown as Record<string, unknown>)[key as string] = queues[i];
  }
  return env;
}

const ctx = {
  waitUntil(p: Promise<unknown>): void {
    void p;
  },
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

describe("ingest worker billing gate", () => {
  let env: Env;

  beforeEach(() => {
    resetRateLimitsForTests();
    env = makeEnv({
      src_test: { workspace_id: "ws_1", secret_token: tokenHash("secret-abc"), status: "active" },
    });
  });

  function makeRequest(): Request {
    return new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
  }

  it("accepts when no plan cache binding is configured", async () => {
    // env has no SOURCE_CACHE / no __PLAN_CACHE_OVERRIDE.
    const res = await worker.fetch(makeRequest(), env, ctx);
    expect(res.status).toBe(202);
  });

  it("accepts when plan state explicitly says accept", async () => {
    const planCache = inMemoryPlanCache();
    await planCache.put(
      "ws_1",
      {
        workspace_id: "ws_1",
        plan: "pro",
        gate: "accept",
        computed_at: new Date().toISOString(),
      },
      300,
    );
    (env as Env & { __PLAN_CACHE_OVERRIDE?: unknown }).__PLAN_CACHE_OVERRIDE = planCache;
    const res = await worker.fetch(makeRequest(), env, ctx);
    expect(res.status).toBe(202);
  });

  it("returns 429 plan_quota_exceeded when free workspace is over the cap", async () => {
    const planCache = inMemoryPlanCache();
    await planCache.put(
      "ws_1",
      {
        workspace_id: "ws_1",
        plan: "free",
        gate: "reject_quota",
        computed_at: new Date().toISOString(),
      },
      300,
    );
    (env as Env & { __PLAN_CACHE_OVERRIDE?: unknown }).__PLAN_CACHE_OVERRIDE = planCache;
    const res = await worker.fetch(makeRequest(), env, ctx);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "plan_quota_exceeded" });
  });

  it("returns 402 billing_suspended when workspace is suspended", async () => {
    const planCache = inMemoryPlanCache();
    await planCache.put(
      "ws_1",
      {
        workspace_id: "ws_1",
        plan: "pro",
        gate: "reject_suspended",
        computed_at: new Date().toISOString(),
      },
      300,
    );
    (env as Env & { __PLAN_CACHE_OVERRIDE?: unknown }).__PLAN_CACHE_OVERRIDE = planCache;
    const res = await worker.fetch(makeRequest(), env, ctx);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "billing_suspended" });
  });

  it("does NOT consult the gate for unauthenticated callers (401 leaks no plan info)", async () => {
    const planCache = inMemoryPlanCache();
    await planCache.put(
      "ws_1",
      {
        workspace_id: "ws_1",
        plan: "free",
        gate: "reject_quota",
        computed_at: new Date().toISOString(),
      },
      300,
    );
    (env as Env & { __PLAN_CACHE_OVERRIDE?: unknown }).__PLAN_CACHE_OVERRIDE = planCache;
    const badTokenReq = new Request("https://axel.app/in/src_test?token=wrong", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
    });
    const res = await worker.fetch(badTokenReq, env, ctx);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_token" });
  });
});
