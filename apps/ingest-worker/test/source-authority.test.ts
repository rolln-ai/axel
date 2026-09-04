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
    expect(origin).toHaveBeenCalledTimes(3);
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
    )).rejects.toThrow(/changed during request verification/);
  });
});
