import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import worker, { type Env } from "../src/index.js";
import type { QueueMessage } from "@axel/shared";
import { resetRateLimitsForTests } from "../src/rate-limit.js";
import { inMemorySourceCache } from "../src/source-cache.js";
import type { SourceAuthorityNamespaceLike } from "../src/source-authority.js";

// Worker stores secret_token as the SHA-256 hex hash of the plaintext token
// the customer presents. Tests construct fixtures with the hash so the worker's
// constant-time comparison succeeds.
function tokenHash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function withSourceToken(
  token: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  return { "x-axel-token": token, ...headers };
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

  it("returns 202 while keeping all inbound metadata values out of Queue", async () => {
    const req = new Request("https://axel.app/in/src_test?signature=do-not-store&client_secret=oauth-secret&refresh_token=oauth-refresh&webhook_secret=custom-secret&code=oauth-code&campaign=query-value-under-innocuous-name", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axel-token": "secret-abc",
        "x-auth-token": "do-not-store",
        "cf-access-jwt-assertion": "do-not-store-either",
        "x-partner-webhook-secret": "custom-secret-header",
        "x-customer-ref": "header-value-under-innocuous-name",
        // A public sender must never be able to mark accepted traffic as
        // non-billable. Only /admin/trigger-event may create test events.
        "x-axel-test": "1",
      },
      body: JSON.stringify({ hello: "world", type: "custom-body-type-must-not-index" }),
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
    expect(allSent[0]!.headers).toEqual({});
    expect(allSent[0]!.query).toEqual({});
    expect(allSent[0]!.is_test).toBe(false);
    expect(allSent[0]!.event_type).toBeUndefined();
    expect(JSON.stringify(allSent[0])).not.toContain("header-value-under-innocuous-name");
    expect(JSON.stringify(allSent[0])).not.toContain("query-value-under-innocuous-name");
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

    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
      body: JSON.stringify({ hello: "world" }),
    });

    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(1);
  });

  it("HMAC-pseudonymizes a low-entropy FIFO value before queueing", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        ordering_enabled: true,
        ordering_key_path: "account.sequence",
      },
    });
    env.ORDERING_KEY_HMAC_SECRET = "ordering-test-secret-32-characters-minimum";
    const res = await worker.fetch(new Request(
      "https://axel.app/in/src_test",
      {
        method: "POST",
        headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
        body: JSON.stringify({ account: { sequence: 1 } }),
      },
    ), env, ctx);

    expect(res.status).toBe(202);
    const queued = Array.from({ length: 16 }, (_, index) => {
      const key = `QUEUE_EVENTS_${index.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.ordering_key).toMatch(/^ord_v1_[a-f0-9]{64}$/);
    expect(queued[0]!.ordering_key).not.toContain(":1");
  });

  it("fails closed before storage when an ordered source has no HMAC key", async () => {
    env = makeEnv({
      src_test: {
        workspace_id: "ws_1",
        secret_token: tokenHash("secret-abc"),
        status: "active",
        ordering_enabled: true,
        ordering_key_path: "account.sequence",
      },
    });
    const res = await worker.fetch(new Request(
      "https://axel.app/in/src_test",
      {
        method: "POST",
        headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
        body: JSON.stringify({ account: { sequence: 1 } }),
      },
    ), env, ctx);

    expect(res.status).toBe(503);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });

  it("requires the ordering HMAC key for every hosted-profile ingest", async () => {
    env.SOURCE_AUTHORITY_REQUIRED = "true";
    const res = await worker.fetch(new Request(
      "https://axel.app/in/src_test",
      {
        method: "POST",
        headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
        body: JSON.stringify({ hello: "world" }),
      },
    ), env, ctx);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: "source_lookup_unavailable",
      retry_after_seconds: 2,
    });
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });

  it("retries Queue code 15000 with the same event and returns 202 on recovery", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Unknown Internal Error (15000)"))
      .mockResolvedValueOnce(undefined);
    for (let i = 0; i < 16; i++) {
      const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
      (env as unknown as Record<string, unknown>)[key as string] = { send };
    }

    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
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

    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
      body: JSON.stringify({ hello: "world" }),
    });
    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({ error: "queue_unavailable", retry_after_seconds: 2 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("keeps a grandfathered feed authenticated, durable, and free of retained URL credentials", async () => {
    env.LEGACY_QUERY_TOKEN_SOURCES = JSON.stringify({ src_test: {
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
    const res = await worker.fetch(new Request("https://axel.app/in/src_test?token=secret-abc", {
      method: "POST", body: '{"kind":"synthetic"}',
    }), env, ctx);
    expect(res.status).toBe(202);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(1);
    const sent = Array.from({ length: 16 }, (_, i) => (env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>).sent).flat();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.query).toEqual({});
    expect(sent[0]?.headers).toEqual({});
    expect(sent[0]?.is_test).toBe(false);
    expect(JSON.stringify(sent)).not.toContain("secret-abc");
  });

  it.each(["wrong", "", "secret-abc&token=secret-abc"])("rejects invalid or ambiguous legacy credentials: %s", async (token) => {
    env.LEGACY_QUERY_TOKEN_SOURCES = JSON.stringify({ src_test: {
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
    const res = await worker.fetch(new Request(`https://axel.app/in/src_test?token=${token}`, {
      method: "POST", body: "{}",
    }), env, ctx);
    expect(res.status).toBe(401);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });

  it("still respects a hosted authority fence during a legacy migration window", async () => {
    env.DEV_MODE = "false";
    env.SOURCE_AUTHORITY = {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ fetch: async () => new Response("", { status: 423 }) }),
    } as SourceAuthorityNamespaceLike;
    env.LEGACY_QUERY_TOKEN_SOURCES = JSON.stringify({ src_test: {
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
    const res = await worker.fetch(new Request("https://axel.app/in/src_test?token=secret-abc", { method: "POST", body: "{}" }), env, ctx);
    expect(res.status).toBe(503);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });

  it("does not use a migration window to bypass named-provider signatures", async () => {
    env.DEV_SOURCES = JSON.stringify({ src_test: { workspace_id: "ws_1", secret_token: tokenHash("secret-abc"), status: "active", provider: "shopify" } });
    env.LEGACY_QUERY_TOKEN_SOURCES = JSON.stringify({ src_test: {
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
    const res = await worker.fetch(new Request("https://axel.app/in/src_test?token=secret-abc", { method: "POST", body: "{}" }), env, ctx);
    expect(res.status).toBe(401);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });

  it("rejects invalid token with 401", async () => {
    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("wrong"),
      body: "{}",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it("rejects a query-string token even when the same valid token is in the header", async () => {
    const queryCredential = "query-credential-must-never-reach-metadata";
    const req = new Request(
      `https://axel.app/in/src_test?token=${encodeURIComponent(queryCredential)}`,
      {
        method: "POST",
        headers: withSourceToken("secret-abc"),
        body: "{}",
      },
    );

    const res = await worker.fetch(req, env, ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "query_token_not_allowed" });
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
    const queued = Array.from({ length: 16 }, (_, index) => {
      const key = `QUEUE_EVENTS_${index.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(0);
  });

  it("requires the x-axel-token header for a custom source", async () => {
    const res = await worker.fetch(new Request("https://axel.app/in/src_test", {
      method: "POST",
      body: "{}",
    }), env, ctx);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "missing_token" });
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });

  it.each(["header", "url"])("does not persist %s-authenticated events when authority changes", async (mode) => {
    delete env.DEV_MODE;
    const authority = {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => ({
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          const body = JSON.parse(String(init?.body)) as { op: string };
          if (body.op === "resolve") {
            return new Response(JSON.stringify({
              source: {
                source_id: "src_test",
                workspace_id: "ws_1",
                name: "Webhook",
                secret_token: tokenHash("secret-abc"),
                url_token_hash: tokenHash("url-secret"),
                status: "active",
              },
              authorization_version: "authority_version_00000001",
            }));
          }
          return new Response(null, { status: 423 });
        }),
      })),
    } satisfies SourceAuthorityNamespaceLike;
    env.SOURCE_AUTHORITY = authority;

    const response = await worker.fetch(new Request(
      `https://axel.app/in/src_test${mode === "url" ? "?url_token=url-secret" : ""}`,
      { method: "POST", headers: mode === "header" ? withSourceToken("secret-abc") : {}, body: "{}" },
    ), env, ctx);

    expect(response.status).toBe(503);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
    const queued = Array.from({ length: 16 }, (_, index) => {
      const key = `QUEUE_EVENTS_${index.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(0);
  });

  it("rejects unknown source with 404", async () => {
    const req = new Request("https://axel.app/in/src_unknown", {
      method: "POST",
      headers: withSourceToken("secret-abc"),
      body: "{}",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it("rejects disabled source with 403", async () => {
    const req = new Request("https://axel.app/in/src_disabled", {
      method: "POST",
      headers: withSourceToken("secret-xyz"),
      body: "{}",
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(403);
  });

  it("rejects non-POST with 405", async () => {
    const req = new Request("https://axel.app/in/src_test", { method: "GET" });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(405);
  });

  it("rejects payload over 1MB with 413", async () => {
    const big = new Uint8Array(MAX_BODY_TEST + 1);
    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc", { "content-length": String(big.byteLength) }),
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
    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
      body: JSON.stringify({ a: { b: { c: true } } }),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_deep" });
  });

  it("never trusts a positive KV source entry for authorization", async () => {
    const cache = inMemorySourceCache();
    const getSpy = vi.spyOn(cache, "get");
    await cache.put("src_test", {
      kind: "hit",
      source: {
        source_id: "src_test",
        workspace_id: "ws_1",
        name: "stale",
        secret_token: tokenHash("revoked-token"),
        status: "active",
      },
    }, 300);
    (env as Env & { __SOURCE_CACHE_OVERRIDE?: unknown }).__SOURCE_CACHE_OVERRIDE = cache;

    const revoked = new Request("https://axel.app/in/src_test", {
      method: "POST",
      body: "{}",
      headers: withSourceToken("revoked-token", { "content-type": "application/json" }),
    });
    expect((await worker.fetch(revoked, env, ctx)).status).toBe(401);
    expect(getSpy).not.toHaveBeenCalled();
  });

  it("does not use KV negative entries to hide newly committed sources", async () => {
    const cache = inMemorySourceCache();
    await cache.put("src_test", { kind: "miss" }, 300);
    const getSpy = vi.spyOn(cache, "get");
    (env as Env & { __SOURCE_CACHE_OVERRIDE?: unknown }).__SOURCE_CACHE_OVERRIDE = cache;

    const request = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc"),
      body: "{}",
    });
    expect((await worker.fetch(request, env, ctx)).status).toBe(202);
    expect(getSpy).not.toHaveBeenCalled();
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

    const req1 = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc"),
      body: "{}",
    });
    const req2 = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc"),
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
    const req = new Request("https://axel.app/in/src_test", {
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
    const req = new Request("https://axel.app/in/src_test", {
      method: "POST",
      headers: withSourceToken("secret-abc", { "content-type": "application/json" }),
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
    const req = new Request("https://axel.app/in/src_test", {
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

  it("accepts a signed Stripe request without an Axel token", async () => {
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

    const req = new Request("https://axel.app/in/src_test", {
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
    expect(queued[0]!.headers).toEqual({});
    expect(queued[0]!.event_type).toBe("invoice.paid");
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
    const req = new Request("https://axel.app/in/src_test", {
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
    expect(queued[0]!.headers).toEqual({});
    expect(queued[0]!.event_type).toBe("subscription_created");
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
    const makeRequest = () => new Request("https://axel.app/in/src_test", {
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
    const makeRequest = () => new Request("https://axel.app/in/src_test", {
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
    const makeRequest = () => new Request("https://axel.app/in/src_test", {
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

    const firstAttempt = await worker.fetch(makeRequest(), env, ctx);
    expect(firstAttempt.status).toBe(500);
    expect(await firstAttempt.json()).toEqual({ error: "internal_error" });
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

// URL credentials are independent of source header tokens and opt in per source.
describe("authenticated webhook URLs", () => {
  const urlToken = `axu_${"u".repeat(43)}`;
  const headerToken = "synthetic-header-token";
  const source = {
    workspace_id: "ws_url",
    name: "Headerless sender",
    secret_token: tokenHash(headerToken),
    url_token_hash: tokenHash(urlToken),
    status: "active",
  };
  function queues(env: Env) {
    return Array.from({ length: 16 }, (_, i) =>
      env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>);
  }
  function request(query = `url_token=${urlToken}`, headers: Record<string, string> = {}, id = "src_url") {
    return new Request(`https://ingest.example.test/in/${id}${query ? `?${query}` : ""}`, {
      method: "POST", headers, body: '{"hello":"world"}',
    });
  }
  it("accepts a URL without headers and persists no credential in event metadata", async () => {
    const env = makeEnv({ src_url: source });
    const res = await worker.fetch(request(), env, ctx);
    expect(res.status).toBe(202);
    const stored = [...(env.EVENTS_RAW as unknown as FakeR2).store.entries()];
    expect(stored).toHaveLength(1);
    expect(new TextDecoder().decode(stored[0]![1].body)).toBe('{"hello":"world"}');
    const messages = queues(env).flatMap((q) => q.sent);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ headers: {}, query: {}, is_test: false });
    expect(JSON.stringify([stored, messages, await res.json()])).not.toContain(urlToken);
  });
  it.each([
    ["URL auth disabled", { url_token_hash: undefined }, `url_token=${urlToken}`, {}, 401],
    ["wrong URL token", {}, "url_token=wrong", {}, 401],
    ["empty URL token", {}, "url_token=", {}, 401],
    ["duplicate URL token", {}, `url_token=${urlToken}&url_token=${urlToken}`, {}, 401],
    ["header and URL", {}, `url_token=${urlToken}`, withSourceToken(headerToken), 401],
    ["empty header and URL", {}, `url_token=${urlToken}`, withSourceToken(""), 401],
    ["header token in URL", {}, `url_token=${headerToken}`, {}, 401],
    ["URL token in header", {}, "", withSourceToken(urlToken), 401],
    ["legacy token parameter", {}, `token=${headerToken}`, {}, 401],
    ["both URL credential parameters", {}, `url_token=${urlToken}&token=${headerToken}`, {}, 401],
    ["disabled source", { status: "disabled" }, `url_token=${urlToken}`, {}, 403],
    ["required custom HMAC", { signing_secret: "synthetic-signing-secret" }, `url_token=${urlToken}`, {}, 401],
    ["IP allowlist", { inbound_ip_allowlist: ["192.0.2.1/32"] }, `url_token=${urlToken}`, {}, 403],
    ...["stripe", "github", "shopify", "chargebee"].map((provider) =>
      [provider, { provider, signing_secret: "synthetic-provider-secret" }, `url_token=${urlToken}`, {}, 401] as const),
  ] as const)("rejects %s before durable writes", async (_name, override, query, headers, status) => {
    const env = makeEnv({ src_url: { ...source, ...override } });
    const res = await worker.fetch(request(query, headers), env, ctx);
    expect(res.status).toBe(status);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
    expect(queues(env).flatMap((q) => q.sent)).toHaveLength(0);
    expect(await res.text()).not.toContain(urlToken);
  });
  it.each([
    ["legacy alone", "token=synthetic-header-token", {}, 202],
    ["URL alone", `url_token=${urlToken}`, {}, 202],
    ["header alone", "", withSourceToken(headerToken), 202],
    ["legacy and URL", `token=${headerToken}&url_token=${urlToken}`, {}, 401],
    ["legacy and header", `token=${headerToken}`, withSourceToken(headerToken), 401],
    ["URL credential in legacy parameter", `token=${urlToken}`, {}, 401],
  ] as const)("preserves credential boundaries during recovery: %s", async (_name, query, headers, status) => {
    const env = makeEnv({ src_url: source });
    env.LEGACY_QUERY_TOKEN_SOURCES = JSON.stringify({ src_url: {
      starts_at: new Date(Date.now() - 60_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
    const res = await worker.fetch(request(query, headers), env, ctx);
    expect(res.status).toBe(status);
    expect(queues(env).flatMap((q) => q.sent)).toHaveLength(status === 202 ? 1 : 0);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(status === 202 ? 1 : 0);
  });
  it("cannot use one source's URL credential on another source", async () => {
    const env = makeEnv({
      src_url: source,
      src_other: { ...source, workspace_id: "ws_other", url_token_hash: tokenHash("another-url-token") },
    });
    expect((await worker.fetch(request(undefined, {}, "src_other"), env, ctx)).status).toBe(401);
    expect((env.EVENTS_RAW as unknown as FakeR2).store.size).toBe(0);
  });
  it("rotates and disables URL credentials without changing header authentication", async () => {
    const replacement = `axu_${"n".repeat(43)}`;
    for (const urlHash of [tokenHash(replacement), undefined]) {
      const env = makeEnv({ src_url: { ...source, url_token_hash: urlHash } });
      expect((await worker.fetch(request(), env, ctx)).status).toBe(401);
      expect((await worker.fetch(request("", withSourceToken(headerToken)), env, ctx)).status).toBe(202);
      expect((await worker.fetch(request(`url_token=${replacement}`), env, ctx)).status).toBe(urlHash ? 202 : 401);
    }
  });
  it("returns a failure if the authenticated event cannot be queued", async () => {
    const env = makeEnv({ src_url: source });
    for (const q of queues(env)) q.send = async () => { throw new Error("synthetic queue failure"); };
    const res = await worker.fetch(request(), env, ctx);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal_error" });
  });
});
