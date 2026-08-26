import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingPg, fakeSession } from "@axel/test-utils";

// Style B (module mock): exercise requestReplayBulk against a capturing fake
// { query } injected via the mocked db/withTransaction, asserting the SQL the
// shared enqueueReplays tail emits and the muted-skip count it reports. No
// real Postgres.

const pg = capturingPg({
  // Answer the replay billing gate (computePlanState) with an accept row,
  // WITHOUT consuming the scripted FIFO.
  intercept: (sql) =>
    /workspace_usage_period/.test(sql) && /FROM workspaces/.test(sql)
      ? {
          rows: [{ workspace_id: "ws_1", plan: "free", billing_status: "ok", total_tasks: "0" }],
          rowCount: 1,
        }
      : undefined,
});
const { calls: pgCalls, responses: pgResponses } = pg;

vi.mock("../lib/db", () => pg.dbModule());

vi.mock("../lib/ids", () => {
  let counter = 0;
  return {
    prefixedId: (prefix: string) => `${prefix}_${++counter}`,
    slugifyWorkspaceName: (s: string) => s,
  };
});

vi.mock("../lib/session", () => ({
  requireSession: async () => fakeSession("owner"),
}));

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () => new Map(),
  cookies: async () => ({ get: () => undefined }),
}));

function formData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

function candidate(over: Record<string, unknown> = {}) {
  return {
    event_id: "evt_1",
    source_id: "src_1",
    r2_key: "k1",
    scope: "route",
    route_id: "rt_1",
    destination_id: null,
    failure_reason: "destination_timeout",
    is_muted: false,
    is_in_flight: false,
    ...over,
  };
}

describe("requestReplayBulk — mute respect (via enqueueReplays)", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
  });

  it("evaluates active mutes per candidate and reports the muted-skip count distinctly", async () => {
    // (1) candidate evaluation SELECT → 1 insertable + 2 muted
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_1" }),
        candidate({ event_id: "evt_2", is_muted: true }),
        candidate({ event_id: "evt_3", is_muted: true }),
      ],
    });
    // (2) INSERT ... RETURNING id → 1 row queued
    pgResponses.push({ rows: [{ id: "rpy_1" }], rowCount: 1 });
    // (3) audit_log INSERT
    pgResponses.push({ rows: [], rowCount: 1 });

    const { requestReplayBulk } = await import("../lib/replay-actions");
    const result = await requestReplayBulk({}, formData({ dead_letter_ids: "1,2,3" }));

    // The shared tail evaluates BOTH guards per candidate: the mute check on
    // the candidate's fingerprint and the exact in-flight dedupe
    // (IS NOT DISTINCT FROM on route + destination).
    const evaluate = pgCalls.find((c) => /WITH candidates AS/.test(c.sql));
    expect(evaluate).toBeDefined();
    expect(evaluate?.sql).toMatch(/dead_letter_mutes/);
    expect(evaluate?.sql).toMatch(/m\.fingerprint = c\.fingerprint/);
    expect(evaluate?.sql).toMatch(/m\.until IS NULL OR m\.until > now\(\)/);
    expect(evaluate?.sql).toMatch(/rr\.route_id IS NOT DISTINCT FROM c\.route_id/);
    expect(evaluate?.sql).toMatch(/rr\.destination_id IS NOT DISTINCT FROM c\.destination_id/);
    expect(evaluate?.sql).toMatch(/state IN \('pending', 'in_progress'\)/);

    // The INSERT carries ONLY the non-muted, non-in-flight candidate, with an
    // app-generated rpy_ id (the one id scheme).
    const insert = pgCalls.find((c) => /INSERT INTO replay_requests/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.params[3]).toEqual(["rpy_1"]);
    expect(insert?.params[4]).toEqual(["evt_1"]);

    // Muted candidates are counted from the evaluation flags — independent of
    // in-flight state — so a muted DL sharing (event_id, route_id) with a
    // queued row is never silently mis-bucketed (the bug this test locks).
    // 1 queued + 2 muted; otherSkipped = (3 - 1) - 2 = 0, so no generic skip note.
    expect(result.notice).toMatch(/Queued 1 replay request/);
    expect(result.notice).toMatch(/2 muted \(unmute to replay\)/);
    expect(result.notice).not.toMatch(/already resolved/);
  });

  it("counts a candidate that is BOTH muted and in flight as muted, not as a generic skip", async () => {
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_1" }),
        candidate({ event_id: "evt_2", is_muted: true, is_in_flight: true }),
      ],
    });
    pgResponses.push({ rows: [{ id: "rpy_1" }], rowCount: 1 }); // INSERT
    pgResponses.push({ rows: [], rowCount: 1 }); // audit

    const { requestReplayBulk } = await import("../lib/replay-actions");
    const result = await requestReplayBulk({}, formData({ dead_letter_ids: "1,2" }));

    expect(result.notice).toMatch(/Queued 1 replay request/);
    expect(result.notice).toMatch(/1 muted \(unmute to replay\)/);
    expect(result.notice).not.toMatch(/already resolved/);
  });

  it("reports muted-only when every selected event is muted (none queued)", async () => {
    pgResponses.push({
      rows: [candidate({ is_muted: true }), candidate({ event_id: "evt_2", is_muted: true })],
    });

    const { requestReplayBulk } = await import("../lib/replay-actions");
    const result = await requestReplayBulk({}, formData({ dead_letter_ids: "1,2" }));

    // No INSERT and no audit row when there is nothing to queue.
    expect(pgCalls.filter((c) => /INSERT INTO replay_requests/.test(c.sql))).toHaveLength(0);
    expect(pgCalls.filter((c) => /INSERT INTO audit_log/.test(c.sql))).toHaveLength(0);
    expect(result.notice).toMatch(/All 2 selected events are muted — unmute to replay/);
    expect(result.error).toBeUndefined();
  });
});
