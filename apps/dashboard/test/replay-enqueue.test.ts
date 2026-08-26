import { beforeEach, describe, expect, it, vi } from "vitest";

// enqueueReplays is the shared tail for all eight replay entry points:
// candidate evaluation (mute + in-flight flags) → insert with app-generated
// prefixedId("rpy") ids → optional tracking job → optional audit row. These
// tests pin the dedupe semantics the per-caller copies used to drift on.

interface PgCall {
  sql: string;
  params: unknown[];
}

const pgCalls: PgCall[] = [];
const pgResponses: Array<{ rows: unknown[]; rowCount?: number }> = [];

const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    pgCalls.push({ sql, params });
    const next = pgResponses.shift() ?? { rows: [], rowCount: 0 };
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
  }),
} as unknown as import("../lib/db").Queryable;

vi.mock("next/cache", () => ({
  updateTag: vi.fn(),
  unstable_cache: (fn: unknown) => fn,
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
}));

import { updateTag } from "next/cache";
import { bustReplayTags, enqueueReplays } from "../lib/replay-enqueue";

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

const base = {
  workspaceId: "ws_1",
  actorUserId: "usr_1",
  reason: "test_reason",
  candidates: { sql: "SELECT 1", params: ["p1"] },
};

describe("enqueueReplays", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
    vi.clearAllMocks();
  });

  it("appends the workspace param AFTER the caller's candidate params and dedups on scope+route+destination", async () => {
    pgResponses.push({ rows: [candidate()] });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 });

    await enqueueReplays(client, base);

    const evaluate = pgCalls[0]!;
    expect(evaluate.sql).toMatch(/WITH candidates AS \(SELECT 1\)/);
    // Caller params first, tail's workspace param appended as $2.
    expect(evaluate.params).toEqual(["p1", "ws_1"]);
    expect(evaluate.sql).toMatch(/\$2/);
    // The in-flight guard matches the EXACT replay (scope + route + destination).
    expect(evaluate.sql).toMatch(/rr\.scope = c\.scope/);
    expect(evaluate.sql).toMatch(/rr\.route_id IS NOT DISTINCT FROM c\.route_id/);
    expect(evaluate.sql).toMatch(/rr\.destination_id IS NOT DISTINCT FROM c\.destination_id/);
    expect(evaluate.sql).toMatch(/rr\.state IN \('pending', 'in_progress'\)/);
    // The mute guard is active-mute only.
    expect(evaluate.sql).toMatch(/m\.fingerprint = c\.fingerprint/);
    expect(evaluate.sql).toMatch(/m\.until IS NULL OR m\.until > now\(\)/);
  });

  it("inserts only non-muted, non-in-flight candidates with prefixedId('rpy') ids and buckets the skips", async () => {
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_ok" }),
        candidate({ event_id: "evt_muted", is_muted: true }),
        candidate({ event_id: "evt_flight", is_in_flight: true }),
        // Muted wins the bucketing even when also in flight.
        candidate({ event_id: "evt_both", is_muted: true, is_in_flight: true }),
      ],
    });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 });

    const result = await enqueueReplays(client, base);

    expect(result.queued).toBe(1);
    expect(result.mutedSkipped).toBe(2);
    expect(result.inFlightSkipped).toBe(1);
    expect(result.replayIds).toHaveLength(1);
    expect(result.replayIds[0]).toMatch(/^rpy_/);

    const insert = pgCalls[1]!;
    expect(insert.sql).toMatch(/INSERT INTO replay_requests/);
    expect(insert.sql).toMatch(/'pending'/);
    // [workspaceId, reason, actor, ids, event_ids, ...]
    expect(insert.params[0]).toBe("ws_1");
    expect(insert.params[1]).toBe("test_reason");
    expect(insert.params[2]).toBe("usr_1");
    expect(insert.params[3]).toEqual(result.replayIds);
    expect(insert.params[4]).toEqual(["evt_ok"]);
  });

  it("does nothing (no insert, no audit, no job) when every candidate is filtered out", async () => {
    pgResponses.push({
      rows: [candidate({ is_muted: true }), candidate({ event_id: "e2", is_in_flight: true })],
    });

    const result = await enqueueReplays(client, {
      ...base,
      audit: { action: "replay.requested" },
      job: { reasonFilter: null },
    });

    expect(result).toEqual({ queued: 0, mutedSkipped: 1, inFlightSkipped: 1, replayIds: [], jobId: null });
    expect(pgCalls).toHaveLength(1); // candidate evaluation only
  });

  it("creates the tracking job BEFORE tagging the inserted rows and merges the job id into the audit metadata", async () => {
    pgResponses.push({ rows: [candidate({ event_id: "a" }), candidate({ event_id: "b" })] });
    pgResponses.push({ rows: [{ id: "x" }, { id: "y" }], rowCount: 2 }); // insert
    pgResponses.push({ rows: [], rowCount: 1 }); // replay_jobs insert
    pgResponses.push({ rows: [], rowCount: 2 }); // tag UPDATE
    pgResponses.push({ rows: [], rowCount: 1 }); // audit insert

    const result = await enqueueReplays(client, {
      ...base,
      audit: { action: "replay.requested_all_unresolved", metadata: { reason: "r" } },
      job: { reasonFilter: "destination_timeout" },
    });

    expect(result.queued).toBe(2);
    expect(result.jobId).toMatch(/^rpyjob_/);

    const jobIdx = pgCalls.findIndex((c) => /INSERT INTO replay_jobs/.test(c.sql));
    const tagIdx = pgCalls.findIndex((c) => /UPDATE replay_requests SET replay_job_id/.test(c.sql));
    const auditIdx = pgCalls.findIndex((c) => /INSERT INTO audit_log/.test(c.sql));
    expect(jobIdx).toBeGreaterThan(0);
    expect(jobIdx).toBeLessThan(tagIdx);
    expect(tagIdx).toBeLessThan(auditIdx);

    expect(pgCalls[tagIdx]!.params).toEqual([result.jobId, result.replayIds]);

    const auditParams = pgCalls[auditIdx]!.params;
    expect(auditParams[2]).toBe("replay.requested_all_unresolved");
    expect(auditParams[4]).toBe("2"); // default targetId = queued count for bulk
    expect(JSON.parse(auditParams[5] as string)).toEqual({
      reason: "r",
      queued: 2,
      replay_job_id: result.jobId,
    });
  });

  it("uses the single replay id as the default audit target when exactly one row queued", async () => {
    pgResponses.push({ rows: [candidate()] });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 });
    pgResponses.push({ rows: [], rowCount: 1 }); // audit

    const result = await enqueueReplays(client, {
      ...base,
      audit: { action: "replay.requested", metadata: { dead_letter_id: "9" } },
    });

    const audit = pgCalls.find((c) => /INSERT INTO audit_log/.test(c.sql))!;
    expect(audit.params[1]).toBe("usr_1");
    expect(audit.params[4]).toBe(result.replayIds[0]);
  });

  it("supports null actors (API keys) but refuses to create a tracking job without a user", async () => {
    pgResponses.push({ rows: [candidate()] });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 });
    pgResponses.push({ rows: [], rowCount: 1 }); // audit

    await enqueueReplays(client, {
      ...base,
      actorUserId: null,
      audit: { action: "api.replay.enqueued", targetType: "event", targetId: "evt_1" },
    });
    const audit = pgCalls.find((c) => /INSERT INTO audit_log/.test(c.sql))!;
    expect(audit.params[1]).toBeNull();
    expect(audit.params[3]).toBe("event");
    expect(audit.params[4]).toBe("evt_1");

    pgCalls.length = 0;
    pgResponses.push({ rows: [candidate()] });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 });
    await expect(
      enqueueReplays(client, { ...base, actorUserId: null, job: { reasonFilter: null } }),
    ).rejects.toThrow(/user actor/);
  });
});

describe("bustReplayTags", () => {
  beforeEach(() => vi.clearAllMocks());

  it("busts replays + dead-letters, plus replay-jobs when a job was created", async () => {
    bustReplayTags("ws_1");
    expect(vi.mocked(updateTag).mock.calls.map((c) => c[0])).toEqual([
      "ws-ws_1-replays",
      "ws-ws_1-dead-letters",
    ]);
    vi.clearAllMocks();
    bustReplayTags("ws_1", { jobs: true });
    expect(vi.mocked(updateTag).mock.calls.map((c) => c[0])).toEqual([
      "ws-ws_1-replays",
      "ws-ws_1-dead-letters",
      "ws-ws_1-replay-jobs",
    ]);
  });
});
