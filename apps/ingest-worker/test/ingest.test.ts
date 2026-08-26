import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import worker, { type Env } from "../src/index.js";
import type { QueueMessage } from "@axel/shared";
import { resetRateLimitsForTests } from "../src/rate-limit.js";
import { inMemorySourceCache } from "../src/source-cache.js";

// Worker stores secret_token as the SHA-256 hex hash of the plaintext token
// the customer presents. Tests construct fixtures with the hash so the worker's
// constant-time comparison succeeds.
function tokenHash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

class FakeR2 {
  store = new Map<string, { body: ArrayBuffer; meta: Record<string, string> }>();
  async put(
    key: string,
    value: ArrayBuffer,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    this.store.set(key, {
      body: value,
      meta: options?.customMetadata ?? {},
    });
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

describe("ingest worker", () => {
  let env: Env;

  beforeEach(() => {
    resetRateLimitsForTests();
    env = makeEnv({
      src_test: { workspace_id: "ws_1", secret_token: tokenHash("secret-abc"), status: "active" },
      src_disabled: { workspace_id: "ws_1", secret_token: tokenHash("secret-xyz"), status: "disabled" },
    });
  });

  it("returns 202 and stores payload + queues message on valid request", async () => {
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { event_id: string; received_at: string };
    expect(body.event_id).toMatch(/^[0-9a-f-]{36}$/);

    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    expect(r2.store.size).toBe(1);
    const [key, entry] = [...r2.store.entries()][0]!;
    expect(key).toMatch(/^events\/ws_1\/\d{4}-\d{2}-\d{2}\//);
    expect(entry.meta.event_id).toBe(body.event_id);

    const allSent = (Array.from({ length: 16 }, (_, i) =>
      env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>,
    ).flatMap((q) => q.sent));
    expect(allSent).toHaveLength(1);
    expect(allSent[0]!.event_id).toBe(body.event_id);
    expect(allSent[0]!.workspace_id).toBe("ws_1");
    expect(allSent[0]!.headers["content-type"]).toBe("application/json");
    expect(allSent[0]!.query).toEqual({});
  });

  it("does not acknowledge when the durable queue write fails", async () => {
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = {
        async send(): Promise<QueueSendResponse> {
          throw new Error("queue unavailable");
        },
      } satisfies Partial<Queue<QueueMessage>>;
    }

    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    await expect(worker.fetch(req, env, ctx)).rejects.toThrow("queue unavailable");
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(1);
  });

  it("retries Queue code 15000 with the same event and returns 202 on recovery", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Unknown Internal Error (15000)"))
      .mockResolvedValueOnce(undefined);
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = { send };
    }

    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(2);
    const first = send.mock.calls[0]?.[0] as QueueMessage;
    const second = send.mock.calls[1]?.[0] as QueueMessage;
    expect(second.event_id).toBe(first.event_id);
    expect(second.r2_key).toBe(first.r2_key);
  });

  it("returns a structured 503 after Queue code 15000 retries are exhausted", async () => {
    const send = vi.fn().mockRejectedValue(new Error("Unknown Internal Error (15000)"));
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = { send };
    }

    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({ error: "queue_unavailable", retry_after_seconds: 2 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid token with 401", async () => {
    const req = new Request("https://axel.app/in/src_test?token=wrong", {
      method: "POST",
      body: "{}",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects unknown source with 404", async () => {
    const req = new Request("https://axel.app/in/src_unknown?token=secret-abc", {
      method: "POST",
      body: "{}",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it("rejects disabled source with 403", async () => {
    const req = new Request("https://axel.app/in/src_disabled?token=secret-xyz", {
      method: "POST",
      body: "{}",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it("rejects non-POST with 405", async () => {
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", { method: "GET" });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(405);
  });

  it("rejects payload over 1MB with 413", async () => {
    const big = new Uint8Array(MAX_BODY_TEST + 1);
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-length": String(big.byteLength) },
      body: big,
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(413);
  });

  it("rejects JSON payloads deeper than the source cap", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        max_body_depth: 2,
      },
    });
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: { b: { c: true } } }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_deep" });
  });

  it("uses the source cache when configured to avoid repeated upstream lookups", async () => {
    const cache = inMemorySourceCache();
    // Hand-rolled spy on the cache to count cache puts vs. cache hits.
    const putSpy = vi.spyOn(cache, "put");
    const getSpy = vi.spyOn(cache, "get");
    (env as Env & { __SOURCE_CACHE_OVERRIDE?: unknown }).__SOURCE_CACHE_OVERRIDE = cache;

    const make = () => new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });

    expect((await worker.fetch(make(), env, ctx)).status).toBe(202);
    expect((await worker.fetch(make(), env, ctx)).status).toBe(202);
    expect((await worker.fetch(make(), env, ctx)).status).toBe(202);

    expect(getSpy).toHaveBeenCalledTimes(3);
    // Only the first call writes to the cache; the rest are cache hits.
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it("negatively caches unknown sources to absorb scanning attacks", async () => {
    const cache = inMemorySourceCache();
    const putSpy = vi.spyOn(cache, "put");
    (env as Env & { __SOURCE_CACHE_OVERRIDE?: unknown }).__SOURCE_CACHE_OVERRIDE = cache;

    const make = () => new Request("https://axel.app/in/src_unknown?token=anything", {
      method: "POST",
      body: "{}",
    });
    expect((await worker.fetch(make(), env, ctx)).status).toBe(404);
    expect((await worker.fetch(make(), env, ctx)).status).toBe(404);
    expect((await worker.fetch(make(), env, ctx)).status).toBe(404);

    // Only one negative-cache write: subsequent lookups hit the cache.
    expect(putSpy).toHaveBeenCalledTimes(1);
  });

  it("rate limits sources before storing or queueing more events", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        max_events_per_minute: 1,
      },
    });

    const req1 = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      body: "{}",
    });
    const req2 = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      body: "{}",
    });

    expect((await worker.fetch(req1, env, ctx)).status).toBe(202);
    const res2 = await worker.fetch(req2, env, ctx);
    expect(res2.status).toBe(429);
    expect(res2.headers.get("retry-after")).toBe("60");
  });

  it("rejects unsigned requests when source has a Stripe signing secret", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "stripe",
        signing_secret: "whsec_stripe_test",
      },
    });
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toBe("invalid_signature");
    expect(body.reason).toBe("missing_signature");

    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    expect(r2.store.size).toBe(0);
  });

  it("accepts a signed Stripe request and continues to R2 + queue", async () => {
    const SECRET = "whsec_stripe_test";
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "stripe",
        signing_secret: SECRET,
      },
    });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: "invoice.paid", amount: 100 });
    const sig = createHash("sha256"); // placeholder so the import is reused
    sig.update(""); // no-op
    const { createHmac } = await import("node:crypto");
    const v1 = createHmac("sha256", SECRET).update(`${ts}.${body}`).digest("hex");

    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${ts},v1=${v1}`,
      },
      body,
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(202);
    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    expect(r2.store.size).toBe(1);
  });
});

const MAX_BODY_TEST = 1_048_576;
