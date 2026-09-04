import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  sweepRawPayloadRetention,
  createClickhouseR2KeyLister,
  createR2HttpDeleter,
  type R2KeyLister,
  type RawRetentionScope,
} from "../src/r2-retention.ts";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-06-04T00:00:00.000Z");
const now = () => NOW;

/** Pool that only answers the resolveScopes query with a fixed scope set. */
function scopePool(scopes: RawRetentionScope[]): Pool {
  return {
    query: vi.fn(async () => ({ rows: scopes, rowCount: scopes.length })),
  } as unknown as Pool;
}

interface ListerCall {
  workspaceId: string;
  sourceId: string;
  cutoffIso: string;
  after: string;
  limit: number;
}

/** Lister that replays scripted pages per source_id and records its args. */
function fakeLister(pagesBySource: Record<string, string[][]>): {
  lister: R2KeyLister;
  calls: ListerCall[];
} {
  const cursors: Record<string, number> = {};
  const calls: ListerCall[] = [];
  return {
    calls,
    lister: {
      async listKeys(args) {
        calls.push(args);
        const seq = pagesBySource[args.sourceId] ?? [];
        const i = cursors[args.sourceId] ?? 0;
        cursors[args.sourceId] = i + 1;
        return seq[i] ?? [];
      },
    },
  };
}

function recordingDeleter(failOn: Set<string> = new Set()): {
  deleter: { delete(key: string): Promise<void> };
  deleted: string[];
} {
  const deleted: string[] = [];
  return {
    deleted,
    deleter: {
      async delete(key: string) {
        if (failOn.has(key)) throw new Error(`boom:${key}`);
        deleted.push(key);
      },
    },
  };
}

describe("sweepRawPayloadRetention", () => {
  it("deletes keys for sub-30-day sources and paginates", async () => {
    const pool = scopePool([{ workspace_id: "ws1", source_id: "s1", effective_days: 7 }]);
    const { lister, calls } = fakeLister({ s1: [["k1", "k2"], ["k3"]] });
    const { deleter, deleted } = recordingDeleter();

    const summary = await sweepRawPayloadRetention(pool, {
      lister,
      deleter,
      now,
      pageSize: 2,
    });

    expect(deleted).toEqual(["k1", "k2", "k3"]);
    expect(summary).toEqual({
      scopes_considered: 1,
      keys_deleted: 3,
      keys_failed: 0,
      budget_exhausted: false,
    });
    // keyset pagination advances `after` to the last key of the prior page.
    expect(calls[0]?.after).toBe("");
    expect(calls[1]?.after).toBe("k2");
  });

  it("applies the safety floor — transient (0d) deletes at now - minAge, not now", async () => {
    const pool = scopePool([{ workspace_id: "ws1", source_id: "transient", effective_days: 0 }]);
    const { lister, calls } = fakeLister({ transient: [["k1"]] });
    const { deleter } = recordingDeleter();

    await sweepRawPayloadRetention(pool, {
      lister,
      deleter,
      now,
      minAgeMs: 7 * DAY_MS,
      pageSize: 50,
    });

    // now (2026-06-04) - 7d = 2026-05-28, formatted as a ClickHouse datetime.
    expect(calls[0]?.cutoffIso).toBe("2026-05-28 00:00:00");
  });

  it("uses the larger of effective retention and the floor", async () => {
    const pool = scopePool([{ workspace_id: "ws1", source_id: "s20", effective_days: 20 }]);
    const { lister, calls } = fakeLister({ s20: [["k1"]] });
    const { deleter } = recordingDeleter();

    await sweepRawPayloadRetention(pool, { lister, deleter, now, minAgeMs: 7 * DAY_MS, pageSize: 50 });

    // max(20d, 7d) = 20d → 2026-06-04 - 20d = 2026-05-15.
    expect(calls[0]?.cutoffIso).toBe("2026-05-15 00:00:00");
  });

  it("stops at the per-tick budget and flags it", async () => {
    const pool = scopePool([{ workspace_id: "ws1", source_id: "s1", effective_days: 1 }]);
    const { lister } = fakeLister({ s1: [["k1", "k2"], ["k3", "k4"]] });
    const { deleter, deleted } = recordingDeleter();

    const summary = await sweepRawPayloadRetention(pool, {
      lister,
      deleter,
      now,
      pageSize: 2,
      maxKeysPerTick: 2,
    });

    expect(deleted).toEqual(["k1", "k2"]); // second page never fetched
    expect(summary.keys_deleted).toBe(2);
    expect(summary.budget_exhausted).toBe(true);
  });

  it("counts failed deletes without aborting the batch", async () => {
    const pool = scopePool([{ workspace_id: "ws1", source_id: "s1", effective_days: 5 }]);
    const { lister } = fakeLister({ s1: [["ok1", "bad", "ok2"]] });
    const { deleter, deleted } = recordingDeleter(new Set(["bad"]));

    const summary = await sweepRawPayloadRetention(pool, { lister, deleter, now, pageSize: 50 });

    expect(deleted.sort()).toEqual(["ok1", "ok2"]);
    expect(summary.keys_deleted).toBe(2);
    expect(summary.keys_failed).toBe(1);
  });

  it("no-ops when no source is under the 30-day ceiling", async () => {
    const pool = scopePool([]);
    const { lister, calls } = fakeLister({});
    const { deleter, deleted } = recordingDeleter();

    const summary = await sweepRawPayloadRetention(pool, { lister, deleter, now });

    expect(calls).toHaveLength(0);
    expect(deleted).toHaveLength(0);
    expect(summary.scopes_considered).toBe(0);
  });
});

describe("createClickhouseR2KeyLister", () => {
  it("POSTs a parameterised query and returns r2_key list", async () => {
    let captured: { url: URL; init: RequestInit } | undefined;
    const fetchImpl = vi.fn(async (url: URL, init: RequestInit) => {
      captured = { url: url as URL, init };
      return new Response(JSON.stringify({ data: [{ r2_key: "events/ws1/2026-01-01/e1" }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const lister = createClickhouseR2KeyLister({ url: "http://ch.local/", user: "u", password: "p", fetchImpl });
    const keys = await lister.listKeys({
      workspaceId: "ws1",
      sourceId: "s1",
      cutoffIso: "2026-05-28 00:00:00",
      after: "events/ws1/2026-01-01/e0",
      limit: 1000,
    });

    expect(keys).toEqual(["events/ws1/2026-01-01/e1"]);
    expect(captured?.init.method).toBe("POST");
    expect(captured?.url.searchParams.get("param_workspace_id")).toBe("ws1");
    expect(captured?.url.searchParams.get("param_source_id")).toBe("s1");
    expect(captured?.url.searchParams.get("param_cutoff")).toBe("2026-05-28 00:00:00");
    expect(captured?.url.searchParams.get("param_prefix")).toBe("events/ws1/");
    expect(String(captured?.init.body)).toContain("FROM events");
  });

  it("returns [] on empty response body", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 })) as unknown as typeof fetch;
    const lister = createClickhouseR2KeyLister({ url: "http://ch.local/", fetchImpl });
    const keys = await lister.listKeys({ workspaceId: "w", sourceId: "s", cutoffIso: "x", after: "", limit: 10 });
    expect(keys).toEqual([]);
  });
});

describe("createR2HttpDeleter", () => {
  const deps = { cloudflareAccountId: "acc", cloudflareApiToken: "tok", rawPayloadBucket: "axel-events-raw" };

  it("treats 200 and 404 as success", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const deleter = createR2HttpDeleter({ ...deps, fetchImpl });
    await expect(deleter.delete("events/ws/k")).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      return new Response("", { status: n === 1 ? 429 : 200 });
    }) as unknown as typeof fetch;
    const deleter = createR2HttpDeleter({ ...deps, fetchImpl });
    await expect(deleter.delete("k")).resolves.toBeUndefined();
    expect(n).toBe(2);
  });

  it("throws immediately on a non-retriable status", async () => {
    const fetchImpl = vi.fn(async () => new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    const deleter = createR2HttpDeleter({ ...deps, fetchImpl });
    const err = await deleter.delete("k").catch((cause: unknown) => cause as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("r2_delete_403");
    expect(err.message).not.toContain("forbidden");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
