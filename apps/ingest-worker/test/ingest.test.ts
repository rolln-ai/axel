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
  async head(key: string): Promise<R2Object | null> {
    const entry = this.store.get(key);
    return entry
      ? ({ key, customMetadata: entry.meta } as unknown as R2Object)
      : null;
  }
  async put(
    key: string,
    value: ArrayBuffer | null,
    options?: R2PutOptions,
  ): Promise<R2Object | null> {
    const condition = options?.onlyIf as R2Conditional | undefined;
    if (condition?.etagDoesNotMatch === "*" && this.store.has(key)) return null;
    this.store.set(key, {
      body: value ?? new ArrayBuffer(0),
      meta: options?.customMetadata ?? {},
    });
    return { key, customMetadata: options?.customMetadata ?? {} } as unknown as R2Object;
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
    const req = new Request("https://axel.app/in/src_test?token=secret-abc&signature=do-not-store&client_secret=oauth-secret&refresh_token=oauth-refresh&webhook_secret=custom-secret&code=oauth-code&event=invoice.paid", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auth-token": "do-not-store",
        "cf-access-jwt-assertion": "do-not-store-either",
        "x-partner-webhook-secret": "custom-secret-header",
      },
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
    expect(allSent[0]!.headers["x-auth-token"]).toBeUndefined();
    expect(allSent[0]!.headers["cf-access-jwt-assertion"]).toBeUndefined();
    expect(allSent[0]!.headers["x-partner-webhook-secret"]).toBeUndefined();
    expect(allSent[0]!.query).toEqual({ event: "invoice.paid" });
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

  it("fails closed when a provider source reaches ingest without a signing secret", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "stripe",
      },
    });
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "invoice.paid" }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({
      error: "source_lookup_unavailable",
      retry_after_seconds: 2,
    });
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
    const queued = Array.from({ length: 16 }, (_, i) => {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(0);
  });

  it("keeps custom sources token-only when no signing secret is configured", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "custom",
      },
    });
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(202);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(1);
    const queued = Array.from({ length: 16 }, (_, i) => {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(1);
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
    expect([...r2.store.keys()][0]).toMatch(/^events\/ws_1\/provider\//);
    const queued = Array.from({ length: 16 }, (_, i) => {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued[0]!.headers["stripe-signature"]).toBeUndefined();
  });

  it("verifies Chargebee Basic auth without persisting the credential", async () => {
    const signingSecret = "chargebee-user:chargebee-password";
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "chargebee",
        signing_secret: signingSecret,
      },
    });
    const authorization = `Basic ${Buffer.from(signingSecret).toString("base64")}`;
    const req = new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: {
        authorization,
        "content-type": "application/json",
        "x-api-key": "also-sensitive",
      },
      body: JSON.stringify({ event_type: "subscription_created" }),
    });

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(202);
    const queued = Array.from({ length: 16 }, (_, i) => {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.headers.authorization).toBeUndefined();
    expect(queued[0]!.headers["x-api-key"]).toBeUndefined();
  });

  it("deduplicates GitHub retries durably by X-GitHub-Delivery", async () => {
    const signingSecret = "github-webhook-secret";
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "github",
        signing_secret: signingSecret,
      },
    });
    const body = JSON.stringify({ action: "opened", issue: { number: 42 } });
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", signingSecret).update(body).digest("hex");
    const makeRequest = () => new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        "x-github-event": "issues",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });

    const first = await worker.fetch(makeRequest(), env, ctx);
    const firstBody = (await first.json()) as { event_id: string; received_at: string };
    const second = await worker.fetch(makeRequest(), env, ctx);
    const secondBody = (await second.json()) as { event_id: string; received_at: string };

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(secondBody).toEqual(firstBody);
    const queued = Array.from({ length: 16 }, (_, i) => {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(2);
    expect(new Set(queued.map((message) => message.event_id))).toEqual(new Set([firstBody.event_id]));
    expect(new Set(queued.map((message) => message.r2_key)).size).toBe(1);
    const rawKeys = [...(env.EVENTS_RAW as unknown as FakeR2).store.keys()];
    expect(rawKeys).toHaveLength(1);
    expect(rawKeys[0]).toMatch(/^events\/ws_1\/provider\//);
  });

  it("gives concurrent copies one deterministic event id", async () => {
    const signingSecret = "github-webhook-secret";
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "github",
        signing_secret: signingSecret,
      },
    });
    const body = JSON.stringify({ action: "reopened", issue: { number: 42 } });
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", signingSecret).update(body).digest("hex");
    const makeRequest = () => new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "4c4e9b4b-c678-4675-8b76-72b21be850b9",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
    const sent: QueueMessage[] = [];
    let release!: () => void;
    const bothAtQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = {
      async send(message: QueueMessage): Promise<void> {
        sent.push(message);
        if (sent.length === 2) release();
        await bothAtQueue;
      },
    };
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = queue;
    }

    const responses = await Promise.all([
      worker.fetch(makeRequest(), env, ctx),
      worker.fetch(makeRequest(), env, ctx),
    ]);
    const responseBodies = await Promise.all(
      responses.map(async (response) => await response.json() as { event_id: string }),
    );

    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((message) => message.event_id)).size).toBe(1);
    expect(new Set(responseBodies.map((message) => message.event_id)).size).toBe(1);
    const rawKeys = [...(env.EVENTS_RAW as unknown as FakeR2).store.keys()];
    expect(rawKeys).toHaveLength(1);
    expect(rawKeys[0]).toMatch(/^events\/ws_1\/provider\//);
  });

  it("does not record a replay marker until the queue accepts the event", async () => {
    const signingSecret = "github-webhook-secret";
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        provider: "github",
        signing_secret: signingSecret,
      },
    });
    const body = JSON.stringify({ action: "closed", issue: { number: 42 } });
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", signingSecret).update(body).digest("hex");
    const makeRequest = () => new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "c4e4a570-04f4-4c44-b6c0-5af704dc51f4",
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body,
    });
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = {
        async send(): Promise<void> {
          throw new Error("queue unavailable");
        },
      };
    }

    await expect(worker.fetch(makeRequest(), env, ctx)).rejects.toThrow("queue unavailable");
    const firstAttemptKeys = [...(env.EVENTS_RAW as unknown as FakeR2).store.keys()];
    expect(firstAttemptKeys).toHaveLength(1);
    expect(firstAttemptKeys[0]).toMatch(/^events\/ws_1\/provider\//);

    const queues = Array.from({ length: 16 }, () => new FakeQueue<QueueMessage>());
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = queues[i];
    }
    const retry = await worker.fetch(makeRequest(), env, ctx);
    expect(retry.status).toBe(202);
    expect(queues.flatMap((queue) => queue.sent)).toHaveLength(1);
    expect([...(env.EVENTS_RAW as unknown as FakeR2).store.keys()]).toEqual(firstAttemptKeys);
  });
});

const MAX_BODY_TEST = 1_048_576;
