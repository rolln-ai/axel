import { afterEach, describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import worker, { type Env } from "../src/index.js";
import type { QueueMessage, Source } from "@axel/shared";
import { handleTriggerEvent, type TriggerEventDeps } from "../src/admin.js";
import { resetRateLimitsForTests } from "../src/rate-limit.js";
import { inMemorySourceCache, type SourceCache } from "../src/source-cache.js";

function tokenHash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

class FakeR2 {
  store = new Map<string, { body: ArrayBuffer; meta: Record<string, string> }>();
  async put(): Promise<R2Object> {
    return {} as R2Object;
  }
  async list(options?: R2ListOptions): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const limit = options?.limit ?? 1_000;
    const keys = [...this.store.keys()].filter((key) => key.startsWith(prefix)).sort();
    const offset = Number.parseInt(options?.cursor ?? "0", 10);
    const objects = keys.slice(offset, offset + limit).map((key) => ({ key }) as R2Object);
    const truncated = offset + objects.length < keys.length;
    return {
      objects,
      truncated,
      ...(truncated ? { cursor: String(offset + objects.length) } : {}),
    } as R2Objects;
  }
  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.store.delete(key);
  }
}

class FakeQueue<T> {
  sent: T[] = [];
  async send(msg: T): Promise<void> {
    this.sent.push(msg);
  }
}

function makeEnv(opts: {
  adminToken?: string;
  cache?: SourceCache;
  devSources?: Record<string, unknown>;
}): Env {
  const queues = Array.from({ length: 16 }, () => new FakeQueue<QueueMessage>());
  const r2 = new FakeR2() as unknown as R2Bucket;
  const env = {
    EVENTS_RAW: r2,
    DEV_MODE: "true",
    DEV_SOURCES: JSON.stringify(opts.devSources ?? {}),
    ...(opts.adminToken !== undefined ? { ADMIN_TOKEN: opts.adminToken } : {}),
    ...(opts.cache !== undefined ? { __SOURCE_CACHE_OVERRIDE: opts.cache } : {}),
  } as unknown as Env;
  for (let i = 0; i < 16; i++) {
    const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
    (env as unknown as Record<string, unknown>)[key as string] = queues[i];
  }
  return env;
}

const ctx = {
  waitUntil(p: Promise<unknown>): void { void p; },
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

describe("admin source-cache invalidation endpoint", () => {
  beforeEach(() => {
    resetRateLimitsForTests();
  });

  function invalidateRequest(token: string | null, body: unknown): Request {
    return new Request("https://axel.test/admin/source-cache/invalidate", {
      method: "POST",
      headers: token === null
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", "x-axel-admin-token": token },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("returns 404 when no admin token is configured (route hidden)", async () => {
    const env = makeEnv({ cache: inMemorySourceCache() });
    const res = await worker.fetch(invalidateRequest("anything", { source_id: "src_1" }), env, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 401 when no admin token header is present", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(invalidateRequest(null, { source_id: "src_1" }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is wrong", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(invalidateRequest("tok-wrong", { source_id: "src_1" }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("uses constant-time comparison so a length mismatch still returns 401", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(invalidateRequest("tok", { source_id: "src_1" }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 when the JSON body is malformed", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(invalidateRequest("tok-admin", "not json"), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when source_id is missing or empty", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    expect((await worker.fetch(invalidateRequest("tok-admin", {}), env, ctx)).status).toBe(400);
    expect((await worker.fetch(invalidateRequest("tok-admin", { source_id: "" }), env, ctx)).status).toBe(400);
    expect((await worker.fetch(invalidateRequest("tok-admin", { source_id: 42 }), env, ctx)).status).toBe(400);
  });

  it("invalidates the named source when auth is correct", async () => {
    const cache = inMemorySourceCache();
    const spy = vi.spyOn(cache, "invalidate");
    const env = makeEnv({ adminToken: "tok-admin", cache });

    // Pre-populate so we can prove invalidate is the actual write.
    await cache.put("src_42", { kind: "miss" }, 60);
    expect(cache.size()).toBe(1);

    const res = await worker.fetch(invalidateRequest("tok-admin", { source_id: "src_42" }), env, ctx);
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledWith("src_42");
    expect(cache.size()).toBe(0);
  });

  it("returns 204 even when no cache is configured (dev mode parity)", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    // No cache override and no SOURCE_CACHE binding.
    const res = await worker.fetch(invalidateRequest("tok-admin", { source_id: "src_1" }), env, ctx);
    expect(res.status).toBe(204);
  });

  it("does not interfere with the normal /in/{source_id} ingest path", async () => {
    const cache = inMemorySourceCache();
    const env = makeEnv({
      adminToken: "tok-admin",
      cache,
      devSources: {
        src_e2e: { workspace_id: "ws_e2e", secret_token: tokenHash("tok-src"), status: "active" },
      },
    });
    const res = await worker.fetch(
      new Request("https://axel.test/in/src_e2e?token=tok-src", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(202);
  });

  it("admin endpoint trims surrounding whitespace from source_id", async () => {
    const cache = inMemorySourceCache();
    const spy = vi.spyOn(cache, "invalidate");
    const env = makeEnv({ adminToken: "tok-admin", cache });
    const res = await worker.fetch(invalidateRequest("tok-admin", { source_id: "  src_x  " }), env, ctx);
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledWith("src_x");
  });

  it("returns 503 when the cache delete fails", async () => {
    const cache: SourceCache = {
      async get() { return undefined; },
      async put() {},
      async invalidate() { throw new Error("KV unavailable"); },
    };
    const env = makeEnv({ adminToken: "tok-admin", cache });
    const res = await worker.fetch(
      invalidateRequest("tok-admin", { source_id: "src_x" }),
      env,
      ctx,
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "cache_invalidation_failed" });
  });
});

describe("admin source-cache PUT endpoint", () => {
  beforeEach(() => {
    resetRateLimitsForTests();
  });

  function putRequest(token: string | null, body: unknown): Request {
    return new Request("https://axel.test/admin/source-cache/put", {
      method: "POST",
      headers: token === null
        ? { "content-type": "application/json" }
        : { "content-type": "application/json", "x-axel-admin-token": token },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  const PUSHED_PLAINTEXT = "axt_pushed_token";
  const VALID_SOURCE = {
    source_id: "src_pushed",
    workspace_id: "ws_1",
    name: "stripe-prod",
    secret_token: tokenHash(PUSHED_PLAINTEXT),
    status: "active" as const,
  };

  it("returns 404 when ADMIN_TOKEN is unset (route hidden)", async () => {
    const env = makeEnv({ cache: inMemorySourceCache() });
    const res = await worker.fetch(putRequest("tok", { source_id: "src_pushed", source: VALID_SOURCE }), env, ctx);
    expect(res.status).toBe(404);
  });

  it("returns 401 with wrong admin token", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(putRequest("tok-wrong", { source_id: "src_pushed", source: VALID_SOURCE }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("returns 400 on malformed JSON body", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(putRequest("tok-admin", "not json"), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when source_id is missing", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(putRequest("tok-admin", { source: VALID_SOURCE }), env, ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when source object is malformed", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(
      putRequest("tok-admin", { source_id: "src_pushed", source: { foo: "bar" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when source.source_id does not match path source_id", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(
      putRequest("tok-admin", { source_id: "src_a", source: { ...VALID_SOURCE, source_id: "src_b" } }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("writes the source to the cache so subsequent lookups resolve it", async () => {
    const cache = inMemorySourceCache();
    const env = makeEnv({ adminToken: "tok-admin", cache });

    // Before push: cache is empty.
    expect(cache.size()).toBe(0);
    const res = await worker.fetch(
      putRequest("tok-admin", { source_id: "src_pushed", source: VALID_SOURCE }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(cache.size()).toBe(1);

    // Now an ingest request with the matching plaintext token should succeed
    // — the worker hashes the presented token before constant-time comparison.
    const ingestRes = await worker.fetch(
      new Request(`https://axel.test/in/src_pushed?token=${PUSHED_PLAINTEXT}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      env,
      ctx,
    );
    expect(ingestRes.status).toBe(202);
  });

  it("defaults admin-pushed source entries to a five-minute TTL", async () => {
    let writtenTtl: number | undefined;
    const cache: SourceCache = {
      async get() { return undefined; },
      async put(_sourceId, _value, ttlSeconds) { writtenTtl = ttlSeconds; },
      async invalidate() {},
    };
    const env = makeEnv({ adminToken: "tok-admin", cache });
    const res = await worker.fetch(
      putRequest("tok-admin", { source_id: "src_pushed", source: VALID_SOURCE }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(writtenTtl).toBe(300);
  });

  it("caps an explicit source-cache TTL at five minutes", async () => {
    let writtenTtl: number | undefined;
    const cache: SourceCache = {
      async get() { return undefined; },
      async put(_sourceId, _value, ttlSeconds) { writtenTtl = ttlSeconds; },
      async invalidate() {},
    };
    const env = makeEnv({ adminToken: "tok-admin", cache });
    const res = await worker.fetch(
      putRequest("tok-admin", {
        source_id: "src_pushed",
        source: VALID_SOURCE,
        ttl_seconds: 31_536_000,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(writtenTtl).toBe(300);
  });

  it("returns 204 with no cache configured (dev parity)", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    const res = await worker.fetch(
      putRequest("tok-admin", { source_id: "src_pushed", source: VALID_SOURCE }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
  });

  it("rejects invalid status values via the source-shape check", async () => {
    const env = makeEnv({ adminToken: "tok-admin", cache: inMemorySourceCache() });
    const res = await worker.fetch(
      putRequest("tok-admin", {
        source_id: "src_pushed",
        source: { ...VALID_SOURCE, status: "weird" },
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});

describe("admin workspace payload deletion", () => {
  function deleteRequest(token: string, body: unknown): Request {
    return new Request("https://axel.test/admin/workspace-payloads/delete-batch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-axel-admin-token": token },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("requires admin auth and a constrained workspace id", async () => {
    const hidden = makeEnv({});
    expect((await worker.fetch(deleteRequest("token", { workspace_id: "ws_1" }), hidden, ctx)).status).toBe(404);

    const env = makeEnv({ adminToken: "tok-admin" });
    expect((await worker.fetch(deleteRequest("wrong", { workspace_id: "ws_1" }), env, ctx)).status).toBe(401);
    expect((await worker.fetch(deleteRequest("tok-admin", { workspace_id: "../other" }), env, ctx)).status).toBe(400);
    expect((await worker.fetch(deleteRequest("tok-admin", { workspace_id: "ws_1" }), env, ctx)).status).toBe(400);
  });

  it("defaults to the workspace root prefix and uses the bucket as the durable checkpoint", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    const bucket = env.EVENTS_RAW as unknown as FakeR2;
    const empty = { body: new ArrayBuffer(0), meta: {} };
    for (let index = 0; index < 9_002; index += 1) {
      bucket.store.set(`events/ws_large/${String(index).padStart(4, "0")}`, empty);
    }
    bucket.store.set("events/ws_other/keep", empty);

    const first = await worker.fetch(
      deleteRequest("tok-admin", { workspace_id: "ws_large", confirmation: "delete:ws_large" }),
      env,
      ctx,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      workspace_id: "ws_large",
      deleted: 6_000,
      complete: false,
    });
    expect(bucket.store.size).toBe(3_003);

    const second = await worker.fetch(
      deleteRequest("tok-admin", { workspace_id: "ws_large", confirmation: "delete:ws_large" }),
      env,
      ctx,
    );
    expect(await second.json()).toEqual({
      workspace_id: "ws_large",
      deleted: 3_002,
      complete: true,
    });
    expect([...bucket.store.keys()]).toEqual(["events/ws_other/keep"]);
  });

  it("full teardown sweeps events, queue-spill, and delivery-mirror prefixes for the workspace", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    const bucket = env.EVENTS_RAW as unknown as FakeR2;
    const empty = { body: new ArrayBuffer(0), meta: {} };
    // The workspace's data across all three R2 families keyed by workspace.
    bucket.store.set("events/ws_gone/2026-07-10/evt-1", empty);
    bucket.store.set("queue-spill/ws_gone/evt-1/dest-1/1.json", empty);
    bucket.store.set("deliveries/ws_gone/2026-07-10/evt-1-dest-1.json", empty);
    // Neighbours that must survive: other workspaces + a similarly-named prefix.
    bucket.store.set("events/ws_gone_2/2026-07-10/keep", empty);
    bucket.store.set("queue-spill/ws_other/evt-9/dest-9/1.json", empty);
    bucket.store.set("deliveries/ws_other/2026-07-10/keep.json", empty);

    const response = await worker.fetch(
      deleteRequest("tok-admin", { workspace_id: "ws_gone", confirmation: "delete:ws_gone" }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspace_id: "ws_gone",
      deleted: 3,
      complete: true,
    });
    expect([...bucket.store.keys()].sort()).toEqual([
      "deliveries/ws_other/2026-07-10/keep.json",
      "events/ws_gone_2/2026-07-10/keep",
      "queue-spill/ws_other/evt-9/dest-9/1.json",
    ]);
  });

  it("sweeps validated custom r2 mirror prefixes passed by the dashboard", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    const bucket = env.EVENTS_RAW as unknown as FakeR2;
    const empty = { body: new ArrayBuffer(0), meta: {} };
    bucket.store.set("exports/ws_gone/2026-07-10/evt-1.json", empty);
    bucket.store.set("nested/path/ws_gone/2026-07-10/evt-2.json", empty);
    bucket.store.set("exports/ws_other/2026-07-10/keep.json", empty);

    const response = await worker.fetch(
      deleteRequest("tok-admin", {
        workspace_id: "ws_gone",
        confirmation: "delete:ws_gone",
        extra_prefixes: ["exports/ws_gone/", "nested/path/ws_gone/"],
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as { deleted: number }).deleted).toBe(2);
    expect([...bucket.store.keys()]).toEqual(["exports/ws_other/2026-07-10/keep.json"]);
  });

  it("rejects extra_prefixes that are not scoped to the workspace (no cross-tenant delete)", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    for (const extra of [
      ["exports/ws_other/"], // another workspace
      ["exports/ws_gone"], // missing trailing slash
      ["ws_gone/"], // no family segment before the workspace id
      "exports/ws_gone/", // not an array
      [42], // non-string element
    ]) {
      const response = await worker.fetch(
        deleteRequest("tok-admin", {
          workspace_id: "ws_gone",
          confirmation: "delete:ws_gone",
          extra_prefixes: extra,
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_extra_prefixes" });
    }
  });

  it("deletes only the requested canonical day partition", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    const bucket = env.EVENTS_RAW as unknown as FakeR2;
    const empty = { body: new ArrayBuffer(0), meta: {} };
    bucket.store.set("events/ws_large/2026-07-08/event-1", empty);
    bucket.store.set("events/ws_large/2026-07-08/event-2", empty);
    bucket.store.set("events/ws_large/2026-07-09/keep", empty);
    bucket.store.set("events/ws_other/2026-07-08/keep", empty);

    const response = await worker.fetch(
      deleteRequest("tok-admin", {
        workspace_id: "ws_large",
        confirmation: "delete:ws_large",
        day: "2026-07-08",
      }),
      env,
      ctx,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      workspace_id: "ws_large",
      day: "2026-07-08",
      deleted: 2,
      complete: true,
    });
    expect([...bucket.store.keys()].sort()).toEqual([
      "events/ws_large/2026-07-09/keep",
      "events/ws_other/2026-07-08/keep",
    ]);
  });

  it("rejects non-canonical and impossible day partitions before deletion", async () => {
    const env = makeEnv({ adminToken: "tok-admin" });
    const bucket = env.EVENTS_RAW as unknown as FakeR2;
    const empty = { body: new ArrayBuffer(0), meta: {} };
    bucket.store.set("events/ws_large/2026-02-28/keep", empty);

    for (const day of ["2026-2-28", "2026-02-30", "2025-02-29", "2026-07-08/../../", null]) {
      const response = await worker.fetch(
        deleteRequest("tok-admin", {
          workspace_id: "ws_large",
          confirmation: "delete:ws_large",
          day,
        }),
        env,
        ctx,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_day" });
    }

    expect([...bucket.store.keys()]).toEqual(["events/ws_large/2026-02-28/keep"]);
  });
});

describe("admin trigger-event endpoint — parity with the public ingest path", () => {
  // The /admin/trigger-event path durably stores the payload in R2 and fans it
  // out to real destinations (is_test=true). It must therefore apply the same
  // redaction + erasure indexing the public /in/<id> path does — otherwise a
  // source's masked PII is persisted/delivered raw and the event is invisible
  // to GDPR erasure.

  function capturingR2() {
    const puts: Array<{ key: string; body: Uint8Array; meta: Record<string, string> }> = [];
    const bucket = {
      async put(key: string, body: ArrayBuffer | Uint8Array, opts?: { customMetadata?: Record<string, string> }) {
        const bytes = body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
        puts.push({ key, body: bytes, meta: opts?.customMetadata ?? {} });
        return {} as R2Object;
      },
    } as unknown as R2Bucket;
    return { bucket, puts };
  }

  type IndexCall = { source: Source; rawBody: Uint8Array; eventId: string; r2Key: string; receivedAt: string };

  function harness(source: Partial<Source>) {
    const r2 = capturingR2();
    const queue = new FakeQueue<QueueMessage>();
    const indexCalls: IndexCall[] = [];
    const logCalls: QueueMessage[] = [];
    const waited: Promise<unknown>[] = [];
    const resolved = {
      source_id: "src_1",
      workspace_id: "ws_1",
      name: "stripe-prod",
      secret_token: "x",
      status: "active",
      ...source,
    } as unknown as Source;
    const deps: TriggerEventDeps = {
      lookupSource: async () => resolved,
      adminToken: "tok-admin",
      rawPayloads: r2.bucket,
      queueForShard: () => queue as unknown as Queue<unknown>,
      uuid: () => "00000000-0000-7000-8000-0000000000aa",
      shardFor: () => 0,
      ctx: { waitUntil: (p) => { waited.push(p); } },
      indexSubjects: async (a) => { indexCalls.push(a as IndexCall); },
      logEvent: async (m) => { logCalls.push(m); },
    };
    return { deps, puts: r2.puts, sent: queue.sent, indexCalls, logCalls, waited };
  }

  function triggerRequest(token: string, body: unknown): Request {
    return new Request("https://axel.test/admin/trigger-event", {
      method: "POST",
      headers: { "content-type": "application/json", "x-axel-admin-token": token },
      body: JSON.stringify(body),
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the authenticated delivery-service fallback when SOURCE_CACHE is absent", async () => {
    const source: Source = {
      source_id: "src_selfhost",
      workspace_id: "ws_selfhost",
      name: "Self-host source",
      secret_token: "stored-token-hash",
      status: "active",
      provider: "custom",
    };
    const lookupFetch = vi.fn(async (_input: string, _init: RequestInit) => (
      new Response(JSON.stringify({ source }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    ));
    vi.stubGlobal("fetch", lookupFetch);

    const env = makeEnv({ adminToken: "tok-admin" });
    delete env.DEV_MODE;
    delete env.DEV_SOURCES;
    env.DELIVERY_SERVICE_URL = "https://delivery.example.test/";
    env.SOURCE_LOOKUP_SHARED_SECRET = "source-lookup-secret"; // gitleaks:allow

    const res = await worker.fetch(
      triggerRequest("tok-admin", {
        source_id: "src_selfhost",
        body: { type: "selfhost.test" },
        actor_kind: "dashboard",
      }),
      env,
      ctx,
    );

    expect(res.status).toBe(202);
    expect(lookupFetch).toHaveBeenCalledOnce();
    expect(lookupFetch.mock.calls[0]).toEqual([
      "https://delivery.example.test/internal/source",
      expect.objectContaining({
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-axel-shared-secret": "source-lookup-secret",
        },
        body: JSON.stringify({ source_id: "src_selfhost" }),
      }),
    ]);
    const queued = Array.from({ length: 16 }, (_, index) => {
      const key = `QUEUE_EVENTS_${index.toString().padStart(2, "0")}` as keyof Env;
      return (env[key] as unknown as FakeQueue<QueueMessage>).sent;
    }).flat();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      source_id: "src_selfhost",
      workspace_id: "ws_selfhost",
      event_type: "selfhost.test",
      is_test: true,
    });
  });

  it("returns a retryable 503 without writing when the fallback is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("upstream unavailable", { status: 503 })));
    const env = makeEnv({ adminToken: "tok-admin" });
    delete env.DEV_MODE;
    delete env.DEV_SOURCES;
    env.DELIVERY_SERVICE_URL = "https://delivery.example.test";
    env.SOURCE_LOOKUP_SHARED_SECRET = "source-lookup-secret"; // gitleaks:allow
    const putSpy = vi.spyOn(env.EVENTS_RAW, "put");

    const res = await worker.fetch(
      triggerRequest("tok-admin", { source_id: "src_selfhost", body: {} }),
      env,
      ctx,
    );

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({
      error: "source_lookup_unavailable",
      retry_after_seconds: 2,
    });
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("redacts configured paths BEFORE the durable R2 write (and sizes the message to the stored body)", async () => {
    const h = harness({ redact_paths: ["card"] });
    const res = await handleTriggerEvent(triggerRequest("tok-admin", { source_id: "src_1", body: { card: "4111111111111111", ok: 1 } }), h.deps);

    expect(res.status).toBe(202);
    const stored = new TextDecoder().decode(h.puts[0]!.body);
    expect(stored).not.toContain("4111111111111111"); // masked, never persisted raw
    expect(stored).toContain("ok"); // untouched fields survive
    expect(h.sent[0]!.size_bytes).toBe(h.puts[0]!.body.byteLength); // size reflects stored, not raw
  });

  it("indexes erasure subjects from the ORIGINAL pre-redaction body, via waitUntil", async () => {
    const h = harness({ redact_paths: ["card"] });
    await handleTriggerEvent(triggerRequest("tok-admin", { source_id: "src_1", body: { card: "4111111111111111", ok: 1 } }), h.deps);

    expect(h.indexCalls).toHaveLength(1);
    // Raw value reaches the indexer so the derived subject_id matches the public
    // path (subject_id is a hash, so this stays pseudonymous downstream).
    expect(new TextDecoder().decode(h.indexCalls[0]!.rawBody)).toContain("4111111111111111");
    expect(h.indexCalls[0]!.eventId).toBe(h.puts[0]!.meta.event_id);
    expect(h.indexCalls[0]!.r2Key).toBe(h.puts[0]!.key);
    // Both post-202 waitUntil promises: erasure indexing + the ClickHouse log.
    expect(h.waited).toHaveLength(2);
  });

  it("stores the body unchanged when the source configured no redact_paths", async () => {
    const h = harness({});
    await handleTriggerEvent(triggerRequest("tok-admin", { source_id: "src_1", body: { card: "4111111111111111", ok: 1 } }), h.deps);
    expect(new TextDecoder().decode(h.puts[0]!.body)).toContain("4111111111111111");
  });

  it("logs the QUEUED message to ClickHouse via waitUntil (event_type stamped), like the public path", async () => {
    // Every sampler / inspection surface reads FROM events in ClickHouse.
    // Without this insert, triggered/seeded events are invisible to Data
    // Contract type discovery no matter how the queue message is stamped —
    // which broke seed-sample-events' "Seed, Refresh, types appear" promise.
    const h = harness({});
    const res = await handleTriggerEvent(
      triggerRequest("tok-admin", { source_id: "src_1", body: { type: "invoice.paid", ok: 1 } }),
      h.deps,
    );
    expect(res.status).toBe(202);
    await Promise.all(h.waited);
    expect(h.logCalls).toHaveLength(1);
    // Exactly the message the queue got — same row the public /in/<id> path
    // would log, so ClickHouse and the queue can never disagree.
    expect(h.logCalls[0]).toEqual(h.sent[0]);
    expect(h.logCalls[0]!.event_type).toBe("invoice.paid");
    expect(h.logCalls[0]!.is_test).toBe(true);
    // Fired post-202 via waitUntil (indexSubjects + logEvent), never blocking.
    expect(h.waited).toHaveLength(2);
  });

  it("still logs to ClickHouse when the payload carries no discriminator (untyped '' bucket)", async () => {
    const h = harness({});
    await handleTriggerEvent(triggerRequest("tok-admin", { source_id: "src_1", body: { id: "x" } }), h.deps);
    await Promise.all(h.waited);
    expect(h.logCalls).toHaveLength(1);
    expect(h.logCalls[0]!.event_type).toBeUndefined(); // field omitted, logger defaults to ''
  });

  it("returns 202 even when the deps omit logEvent (older wiring)", async () => {
    const h = harness({});
    delete (h.deps as Partial<TriggerEventDeps>).logEvent;
    const res = await handleTriggerEvent(triggerRequest("tok-admin", { source_id: "src_1", body: { type: "a" } }), h.deps);
    expect(res.status).toBe(202);
    expect(h.sent).toHaveLength(1);
  });
});
