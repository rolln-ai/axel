import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@axel/shared";
import {
  beginSourceAuthorizationWithAuthority,
  confirmSourceAuthorizationWithAuthority,
  resolveSourceWithAuthority,
  SourceAuthorityDurableObject,
  type SourceAuthorityNamespaceLike,
} from "../src/source-authority.js";

const OLD_SOURCE: Source = {
  source_id: "src_1",
  workspace_id: "ws_1",
  name: "Webhook",
  secret_token: "old-hash",
  status: "active",
};

const NEW_SOURCE: Source = {
  ...OLD_SOURCE,
  secret_token: "new-hash",
};

class FakeStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async setAlarm(_scheduledTime: number): Promise<void> {}

  async deleteAlarm(): Promise<void> {}

  snapshot(): string {
    return JSON.stringify([...this.values.values()]);
  }
}

function durableObject(storage = new FakeStorage()): SourceAuthorityDurableObject {
  const state = { storage } as unknown as DurableObjectState;
  return new SourceAuthorityDurableObject(state, {
    DELIVERY_SERVICE_URL: "https://delivery.example.test",
    SOURCE_LOOKUP_SHARED_SECRET: "test-shared-secret",
  });
}

function operation(
  object: SourceAuthorityDurableObject,
  body: unknown,
): Promise<Response> {
  return object.fetch(new Request("https://authority.internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SourceAuthorityDurableObject", () => {
  it("preserves safe origin diagnostics and does not cache an outage as a missing source", async () => {
    const origin = vi.fn().mockImplementation(async () => new Response("private provider response", { status: 503 }));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();
    const result = await operation(object, { op: "resolve", source_id: "src_1" });
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "source_lookup_unavailable", reason: "lookup_http", http_status: 503 });
    expect(origin).toHaveBeenCalledTimes(2);
    origin.mockImplementation(async () => new Response(JSON.stringify({ source: OLD_SOURCE })));
    expect(await (await operation(object, { op: "resolve", source_id: "src_1" })).json())
      .toMatchObject({ source: OLD_SOURCE });
    expect(origin).toHaveBeenCalledTimes(3);
  });
  it("loads cold state from the authenticated origin and reuses committed state", async () => {
    const origin = vi.fn(async () => new Response(JSON.stringify({ source: OLD_SOURCE }), {
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();

    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(200);
    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(200);
    expect(origin).toHaveBeenCalledOnce();
  });

  it("fences config drift found during the five-minute refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    const origin = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: OLD_SOURCE })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: NEW_SOURCE })));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();

    await operation(object, { op: "resolve", source_id: "src_1" });
    vi.setSystemTime(new Date("2026-08-27T00:05:01Z"));
    const refreshed = await operation(object, { op: "resolve", source_id: "src_1" });
    expect(refreshed.status).toBe(423);
    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(423);
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("refreshes an unchanged source after five minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T00:00:00Z"));
    const origin = vi.fn(async () => new Response(JSON.stringify({ source: OLD_SOURCE })));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();

    await operation(object, { op: "resolve", source_id: "src_1" });
    vi.setSystemTime(new Date("2026-08-27T00:05:01Z"));
    const refreshed = await operation(object, { op: "resolve", source_id: "src_1" });
    expect(await refreshed.json()).toMatchObject({ source: OLD_SOURCE });
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("confirms unchanged credentials across cache expiry, cold object: %s", async (cold) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-09-13T00:00:00Z");
    vi.setSystemTime(startedAt);
    const origin = vi.fn(async () => Response.json({ source: OLD_SOURCE }));
    vi.stubGlobal("fetch", origin);
    const storage = new FakeStorage();
    let object = durableObject(storage);
    await operation(object, { op: "resolve", source_id: "src_1" });
    vi.setSystemTime(startedAt + 299_999);
    const begun = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
    if (cold) object = durableObject(storage);
    vi.setSystemTime(startedAt + 300_001);

    expect((await operation(object, { op: "confirm", source_id: "src_1",
      authorization_version: begun.authorization_version })).status).toBe(204);
    const refreshed = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
    expect(refreshed.authorization_version).toBe(begun.authorization_version);
    expect(origin).toHaveBeenCalledTimes(2);
    expect(storage.snapshot()).not.toContain(OLD_SOURCE.secret_token);
  });

  it("keeps an in-flight authorization valid when another request refreshes the cache", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-09-13T00:00:00Z");
    vi.setSystemTime(startedAt);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ source: OLD_SOURCE })));
    const object = durableObject();
    const begun = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
    vi.setSystemTime(startedAt + 300_001);
    await operation(object, { op: "resolve", source_id: "src_1" });
    expect((await operation(object, { op: "confirm", source_id: "src_1",
      authorization_version: begun.authorization_version })).status).toBe(204);
  });

  it.each([NEW_SOURCE, { ...OLD_SOURCE, status: "disabled" }, null])(
    "fences changed or deleted config discovered by an expired confirmation: %j", async (changedSource) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = Date.parse("2026-09-13T00:00:00Z");
      vi.setSystemTime(startedAt);
      const origin = vi.fn().mockResolvedValueOnce(Response.json({ source: OLD_SOURCE }))
        .mockResolvedValueOnce(Response.json({ source: changedSource }));
      vi.stubGlobal("fetch", origin);
      const object = durableObject();
      const begun = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
      vi.setSystemTime(startedAt + 300_001);
      expect((await operation(object, { op: "confirm", source_id: "src_1",
        authorization_version: begun.authorization_version })).status).toBe(423);
      expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(423);
      expect(origin).toHaveBeenCalledTimes(2);
    },
  );

  it("does not confirm expired credentials during an origin outage and recovers on refresh", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-09-13T00:00:00Z");
    vi.setSystemTime(startedAt);
    const origin = vi.fn(async () => Response.json({ source: OLD_SOURCE }));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();
    const begun = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
    vi.setSystemTime(startedAt + 300_001);
    origin.mockImplementation(async () => new Response("private upstream error", { status: 503 }));
    const confirm = { op: "confirm", source_id: "src_1", authorization_version: begun.authorization_version };
    const unavailable = await operation(object, confirm);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "source_lookup_unavailable", reason: "lookup_http", http_status: 503 });
    expect(origin).toHaveBeenCalledTimes(3);
    origin.mockImplementation(async () => Response.json({ source: OLD_SOURCE }));
    expect((await operation(object, confirm)).status).toBe(204);
    expect(origin).toHaveBeenCalledTimes(4);
  });

  it("revokes an old version after a fence even when the committed config is unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ source: OLD_SOURCE })));
    const object = durableObject();
    const begun = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
    const fence = { source_id: "src_1", fence_token: "fence_token_00000001" };
    await operation(object, { op: "fence", ...fence });
    await operation(object, { op: "sync", ...fence, source: OLD_SOURCE });
    expect((await operation(object, { op: "confirm", source_id: "src_1",
      authorization_version: begun.authorization_version })).status).toBe(423);
  });

  it("serializes an expiry refresh before a queued fence acknowledges", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-09-13T00:00:00Z");
    vi.setSystemTime(startedAt);
    const origin = vi.fn(async () => Response.json({ source: OLD_SOURCE }));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();
    const begun = await (await operation(object, { op: "resolve", source_id: "src_1" })).json() as { authorization_version: string };
    vi.setSystemTime(startedAt + 300_001);
    let releaseOrigin!: () => void;
    let markRefreshStarted!: () => void;
    const waiting = new Promise<void>((resolve) => { releaseOrigin = resolve; });
    const started = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    origin.mockImplementation(async () => { markRefreshStarted(); await waiting; return Response.json({ source: OLD_SOURCE }); });
    const confirm = { op: "confirm", source_id: "src_1", authorization_version: begun.authorization_version };
    const confirming = operation(object, confirm);
    await started;
    let fenceFinished = false;
    const fencing = operation(object, { op: "fence", source_id: "src_1", fence_token: "fence_token_00000001" })
      .then((response) => { fenceFinished = true; return response; });
    await Promise.resolve();
    expect(fenceFinished).toBe(false);
    releaseOrigin();
    expect((await confirming).status).toBe(204);
    expect((await fencing).status).toBe(204);
    expect((await operation(object, confirm)).status).toBe(423);
  });

  it("persists only a digest, never source credentials or signing secrets", async () => {
    const secretSource = {
      ...OLD_SOURCE,
      signing_secret: "do-not-store-signing-secret",
      signing_secret_previous: "do-not-store-previous-secret",
    };
    vi.stubGlobal("fetch", vi.fn(async () => (
      new Response(JSON.stringify({ source: secretSource }))
    )));
    const storage = new FakeStorage();
    const object = durableObject(storage);

    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(200);
    expect(storage.snapshot()).not.toContain(secretSource.secret_token);
    expect(storage.snapshot()).not.toContain(secretSource.signing_secret);
    expect(storage.snapshot()).not.toContain(secretSource.signing_secret_previous);
    expect(storage.snapshot()).not.toContain('"source"');
    expect(storage.snapshot()).not.toContain(secretSource.source_id);
    expect(storage.snapshot()).toMatch(/"sourceIdDigest":"[a-f0-9]{64}"/);
    expect(storage.snapshot()).toMatch(/"sourceFingerprint":"[a-f0-9]{64}"/);
  });

  it("blocks every lookup after the fence is acknowledged", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ source: OLD_SOURCE }))));
    const object = durableObject();
    await operation(object, { op: "resolve", source_id: "src_1" });

    const fenced = await operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
    });
    expect(fenced.status).toBe(204);
    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(423);
  });

  it("unblocks only when matching committed config is synced", async () => {
    const object = durableObject();
    await operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
    });

    const synced = await operation(object, {
      op: "sync",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
      source: NEW_SOURCE,
    });
    expect(synced.status).toBe(204);
    const resolved = await operation(object, { op: "resolve", source_id: "src_1" });
    expect(await resolved.json()).toMatchObject({ source: NEW_SOURCE });
  });

  it("re-fences on an out-of-order sync token", async () => {
    const object = durableObject();
    await operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "newer_fence_00000001",
    });

    const stale = await operation(object, {
      op: "sync",
      source_id: "src_1",
      fence_token: "older_fence_00000001",
      source: OLD_SOURCE,
    });
    expect(stale.status).toBe(409);
    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(423);
  });

  it("serializes a fence behind earlier authorization work", async () => {
    let releaseOrigin: (() => void) | undefined;
    const originWait = new Promise<void>((resolve) => { releaseOrigin = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await originWait;
      return new Response(JSON.stringify({ source: OLD_SOURCE }));
    }));
    const object = durableObject();

    const resolving = operation(object, { op: "resolve", source_id: "src_1" });
    const fencing = operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
    });
    let fenceFinished = false;
    void fencing.then(() => { fenceFinished = true; });
    await Promise.resolve();
    expect(fenceFinished).toBe(false);

    releaseOrigin?.();
    expect((await resolving).status).toBe(200);
    expect((await fencing).status).toBe(204);
    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(423);
  });

  it("stores a deletion as an authoritative miss", async () => {
    const object = durableObject();
    await operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
    });
    expect((await operation(object, {
      op: "sync",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
      source: null,
    })).status).toBe(204);
    expect(await (await operation(object, { op: "resolve", source_id: "src_1" })).json())
      .toMatchObject({ source: null });
  });

  it("refreshes committed config for an old dashboard's post-commit invalidation", async () => {
    const origin = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: OLD_SOURCE })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: NEW_SOURCE })));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();
    const first = await operation(object, { op: "resolve", source_id: "src_1" });
    const oldVersion = (await first.json() as { authorization_version: string }).authorization_version;

    expect((await operation(object, {
      op: "legacy_invalidate",
      source_id: "src_1",
    })).status).toBe(204);
    const refreshed = await operation(object, { op: "resolve", source_id: "src_1" });
    const body = await refreshed.json() as {
      source: Source;
      authorization_version: string;
    };
    expect(body.source).toMatchObject(NEW_SOURCE);
    expect(body.authorization_version).not.toBe(oldVersion);
    expect(origin).toHaveBeenCalledTimes(2);
  });

  it("keeps a failed legacy refresh closed and self-repairs on the next resolve", async () => {
    const origin = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: OLD_SOURCE })))
      .mockRejectedValueOnce(new Error("origin temporarily unavailable"))
      .mockRejectedValueOnce(new Error("origin still unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ source: NEW_SOURCE })));
    vi.stubGlobal("fetch", origin);
    const object = durableObject();
    await operation(object, { op: "resolve", source_id: "src_1" });

    expect((await operation(object, {
      op: "legacy_invalidate",
      source_id: "src_1",
    })).status).toBe(503);
    const repaired = await operation(object, { op: "resolve", source_id: "src_1" });
    expect(await repaired.json()).toMatchObject({ source: NEW_SOURCE });
    expect(origin).toHaveBeenCalledTimes(4);
  });

  it("never lets a legacy invalidation override an explicit mutation fence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ source: NEW_SOURCE }))));
    const object = durableObject();
    await operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
    });

    expect((await operation(object, {
      op: "legacy_invalidate",
      source_id: "src_1",
    })).status).toBe(423);
    expect((await operation(object, { op: "resolve", source_id: "src_1" })).status).toBe(423);
  });
});

describe("resolveSourceWithAuthority", () => {
  it("uses direct origin on every request when the binding is absent", async () => {
    const direct = vi.fn().mockResolvedValue(OLD_SOURCE);
    await resolveSourceWithAuthority({}, "src_1", direct);
    await resolveSourceWithAuthority({}, "src_1", direct);
    expect(direct).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the hosted profile loses its required binding", async () => {
    const direct = vi.fn().mockResolvedValue(OLD_SOURCE);
    await expect(resolveSourceWithAuthority(
      { SOURCE_AUTHORITY_REQUIRED: "true" },
      "src_1",
      direct,
    )).rejects.toThrow(/required source authority binding/);
    expect(direct).not.toHaveBeenCalled();
  });

  it("keeps explicit local development on its injected direct lookup", async () => {
    const namespace = {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(),
    } satisfies SourceAuthorityNamespaceLike;
    const direct = vi.fn().mockResolvedValue(OLD_SOURCE);
    await resolveSourceWithAuthority(
      { SOURCE_AUTHORITY: namespace, DEV_MODE: "true" },
      "src_1",
      direct,
    );
    expect(direct).toHaveBeenCalledOnce();
    expect(namespace.get).not.toHaveBeenCalled();
  });

  it("fails closed while the hosted authority is fenced", async () => {
    const namespace = {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => ({ fetch: vi.fn(async () => new Response(null, { status: 423 })) })),
    } satisfies SourceAuthorityNamespaceLike;
    const direct = vi.fn();

    await expect(resolveSourceWithAuthority({ SOURCE_AUTHORITY: namespace }, "src_1", direct))
      .rejects.toThrow(/temporarily fenced/);
    expect(direct).not.toHaveBeenCalled();
  });

  it("carries only validated failure codes across the authority boundary", async () => {
    const call = vi.fn(async () => new Response(JSON.stringify({
      error: "source_lookup_unavailable", reason: "lookup_timeout", http_status: 504,
      message: "upstream secret", source: OLD_SOURCE,
    }), { status: 503 }));
    const namespace = {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => ({ fetch: call })),
    } satisfies SourceAuthorityNamespaceLike;
    const direct = vi.fn();
    await expect(resolveSourceWithAuthority({ SOURCE_AUTHORITY: namespace }, "src_1", direct))
      .rejects.toMatchObject({ reason: "lookup_timeout", httpStatus: 504, message: "source authority lookup failed" });
    call.mockResolvedValueOnce(new Response(JSON.stringify({ reason: "secret-invalid-code" }), { status: 503 }));
    await expect(resolveSourceWithAuthority({ SOURCE_AUTHORITY: namespace }, "src_1", direct))
      .rejects.toMatchObject({ reason: "authority_unavailable" });
    await expect(confirmSourceAuthorizationWithAuthority({ SOURCE_AUTHORITY: namespace }, "src_1", "authorization_version_0001"))
      .rejects.toMatchObject({ reason: "lookup_timeout", httpStatus: 504, message: "source authority lookup failed" });
    call.mockResolvedValueOnce(new Response(JSON.stringify({ reason: "secret-invalid-code" }), { status: 503 }));
    await expect(confirmSourceAuthorizationWithAuthority({ SOURCE_AUTHORITY: namespace }, "src_1", "authorization_version_0001"))
      .rejects.toMatchObject({ reason: "authority_unavailable" });
    expect(direct).not.toHaveBeenCalled();
  });

  it("rejects an in-flight authorization after a fence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ source: OLD_SOURCE }))));
    const object = durableObject();
    const namespace = {
      idFromName: vi.fn(() => ({}) as DurableObjectId),
      get: vi.fn(() => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => (
          object.fetch(new Request(input, init))
        ),
      })),
    } satisfies SourceAuthorityNamespaceLike;
    const env = { SOURCE_AUTHORITY: namespace };

    const begun = await beginSourceAuthorizationWithAuthority(env, "src_1", vi.fn());
    expect(begun.authorizationVersion).toMatch(/^[a-f0-9]{32}$/);
    await operation(object, {
      op: "fence",
      source_id: "src_1",
      fence_token: "fence_token_00000001",
    });

    await expect(confirmSourceAuthorizationWithAuthority(
      env,
      "src_1",
      begun.authorizationVersion,
    )).rejects.toMatchObject({ reason: "authorization_changed", httpStatus: 423 });
  });
});
