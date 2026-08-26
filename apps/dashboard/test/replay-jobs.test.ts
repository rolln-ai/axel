import { afterEach, describe, expect, it, vi } from "vitest";
import { capturingPg } from "@axel/test-utils";
import type { Queryable } from "../lib/db";

// Deterministic ids so createReplayJob's INSERT params are assertable.
vi.mock("../lib/ids", () => {
  let counter = 0;
  return { prefixedId: (prefix: string) => `${prefix}_${++counter}` };
});

interface PgCall {
  sql: string;
  params: unknown[];
}

/**
 * Sequential fake Queryable: each query() captures { sql, params } and returns
 * the next canned rows from `queue`. No real Postgres.
 */
function fakeDb(queue: unknown[][]): { captured: PgCall[]; db: Queryable } {
  const { query, calls } = capturingPg({ responses: queue.map((rows) => ({ rows })) });
  return { db: { query }, captured: calls };
}

afterEach(() => vi.restoreAllMocks());

describe("replay-jobs — createReplayJob", () => {
  it("inserts a pending replay_jobs row with the expected columns + params", async () => {
    const { captured, db } = fakeDb([[]]);
    const { createReplayJob } = await import("../lib/replay-jobs");

    const result = await createReplayJob(
      {
        workspaceId: "ws_1",
        requestedByUserId: "usr_1",
        reason: "replay_all_unresolved",
        reasonFilter: null,
        total: 42,
      },
      db,
    );

    // Id is pre-generated via prefixedId("rpyjob") and returned so the caller
    // can tag the matching replay_requests rows in the same transaction.
    expect(result.id).toBe("rpyjob_1");

    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/INSERT INTO replay_jobs/);
    // pending state literal, no started/finished timestamps yet.
    expect(captured[0]?.sql).toMatch(/'pending'/);
    // Column list and the FK-bearing workspace column.
    expect(captured[0]?.sql).toMatch(/workspace_id/);
    expect(captured[0]?.sql).toMatch(/requested_by_user_id/);
    expect(captured[0]?.sql).toMatch(/reason_filter/);
    // Params in declared order: id, ws, user, reason, reasonFilter, total.
    expect(captured[0]?.params).toEqual([
      "rpyjob_1",
      "ws_1",
      "usr_1",
      "replay_all_unresolved",
      null,
      42,
    ]);
  });

  it("threads a non-null reason_filter through as the 5th param", async () => {
    const { captured, db } = fakeDb([[]]);
    const { createReplayJob } = await import("../lib/replay-jobs");

    await createReplayJob(
      {
        workspaceId: "ws_2",
        requestedByUserId: "usr_2",
        reason: "replay_all_unresolved",
        reasonFilter: "destination_timeout",
        total: 7,
      },
      db,
    );

    expect(captured[0]?.params[4]).toBe("destination_timeout");
    expect(captured[0]?.params[5]).toBe(7);
  });
});

describe("replay-jobs — getActiveReplayJob", () => {
  it("returns null when there is no active job", async () => {
    const { captured, db } = fakeDb([[]]); // job query returns no rows
    const { getActiveReplayJob } = await import("../lib/replay-jobs");

    const result = await getActiveReplayJob("ws_1", db);

    expect(result).toBeNull();
    // Only the job lookup runs; no GROUP BY when there's no job.
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sql).toMatch(/FROM replay_jobs/);
    expect(captured[0]?.sql).toMatch(/state IN \('pending', 'running'\)/);
    expect(captured[0]?.sql).toMatch(/ORDER BY requested_at DESC/);
    expect(captured[0]?.params).toEqual(["ws_1"]);
  });

  it("maps the job row + GROUP BY counts into live progress numbers", async () => {
    const { captured, db } = fakeDb([
      // Query 1 — the job row. pg hands back bigint/count as strings.
      [
        {
          id: "rpyjob_1",
          state: "running",
          reason: "replay_all_unresolved",
          reason_filter: null,
          total: "100",
          succeeded_count: "40",
          failed_count: "5",
          requested_at: "2026-06-04T00:00:00Z",
          started_at: "2026-06-04T00:01:00Z",
          finished_at: null,
          error_message: null,
        },
      ],
      // Query 2 — GROUP BY over replay_requests.state (counts as STRINGS).
      [
        { state: "done", n: "40" },
        { state: "failed", n: "5" },
        { state: "pending", n: "30" },
        { state: "in_progress", n: "25" },
      ],
    ]);
    const { getActiveReplayJob } = await import("../lib/replay-jobs");

    const result = await getActiveReplayJob("ws_1", db);

    expect(result).not.toBeNull();
    // String -> number normalization for the denormalized counters + total.
    expect(result?.total).toBe(100);
    expect(result?.succeeded_count).toBe(40);
    expect(result?.failed_count).toBe(5);
    // Live per-state counts from the GROUP BY.
    expect(result?.done).toBe(40);
    expect(result?.failed).toBe(5);
    expect(result?.pending).toBe(30);
    expect(result?.in_progress).toBe(25);
    // remaining = pending + in_progress.
    expect(result?.remaining).toBe(55);

    // Second query is keyed on the job id and groups by state.
    expect(captured[1]?.sql).toMatch(/FROM replay_requests/);
    expect(captured[1]?.sql).toMatch(/replay_job_id = \$1/);
    expect(captured[1]?.sql).toMatch(/GROUP BY state/);
    expect(captured[1]?.params).toEqual(["rpyjob_1"]);
  });

  it("treats absent state buckets as zero (no rows for a state)", async () => {
    const { db } = fakeDb([
      [
        {
          id: "rpyjob_9",
          state: "pending",
          reason: "replay_all_unresolved",
          reason_filter: null,
          total: "3",
          succeeded_count: "0",
          failed_count: "0",
          requested_at: "2026-06-04T00:00:00Z",
          started_at: null,
          finished_at: null,
          error_message: null,
        },
      ],
      // Only a pending bucket exists yet; nothing has been claimed/finished.
      [{ state: "pending", n: "3" }],
    ]);
    const { getActiveReplayJob } = await import("../lib/replay-jobs");

    const result = await getActiveReplayJob("ws_1", db);

    expect(result?.pending).toBe(3);
    expect(result?.in_progress).toBe(0);
    expect(result?.done).toBe(0);
    expect(result?.failed).toBe(0);
    expect(result?.remaining).toBe(3);
  });
});

describe("replay-jobs — getInvestigationReplayJob", () => {
  it("finds a matching active or recently finished group and hydrates live counts", async () => {
    const { captured, db } = fakeDb([
      [
        {
          id: "rpyjob_group",
          state: "done",
          reason: "investigation_replay_all",
          reason_filter: "router_processing_failed",
          total: "48",
          succeeded_count: "46",
          failed_count: "2",
          requested_at: "2026-07-24T14:00:00Z",
          started_at: "2026-07-24T14:00:01Z",
          finished_at: "2026-07-24T14:01:00Z",
          error_message: null,
        },
      ],
      [
        { state: "done", n: "46" },
        { state: "failed", n: "2" },
      ],
    ]);
    const { getInvestigationReplayJob } = await import("../lib/replay-jobs");

    const result = await getInvestigationReplayJob(
      "ws_1",
      "src_1",
      "router_processing_failed",
      db,
    );

    expect(result?.state).toBe("done");
    expect(result?.done).toBe(46);
    expect(result?.failed).toBe(2);
    expect(result?.remaining).toBe(0);
    expect(captured[0]?.sql).toMatch(/j\.finished_at > now\(\) - interval '15 minutes'/);
    expect(captured[0]?.sql).toMatch(/EXISTS[\s\S]*FROM replay_requests rr/);
    expect(captured[0]?.sql).toMatch(/rr\.source_id = \$2/);
    expect(captured[0]?.sql).toMatch(/rr\.failure_reason = \$3/);
    expect(captured[0]?.params).toEqual([
      "ws_1",
      "src_1",
      "router_processing_failed",
    ]);
  });
});

describe("replay-jobs — replayJobProgress helper math", () => {
  // Minimal ActiveReplayJob builder; only the fields the helper reads matter.
  function activeJob(overrides: {
    total: number;
    done: number;
    failed: number;
    remaining: number;
  }) {
    return {
      id: "rpyjob_1",
      state: "running" as const,
      reason: "replay_all_unresolved",
      reason_filter: null,
      total: overrides.total,
      succeeded_count: 0,
      failed_count: 0,
      requested_at: "2026-06-04T00:00:00Z",
      started_at: "2026-06-04T00:01:00Z",
      finished_at: null,
      error_message: null,
      pending: 0,
      in_progress: 0,
      done: overrides.done,
      failed: overrides.failed,
      remaining: overrides.remaining,
    };
  }

  it("computes settled, remaining, and an integer percent", async () => {
    const { replayJobProgress } = await import("../lib/replay-jobs");
    const p = replayJobProgress(activeJob({ total: 100, done: 40, failed: 5, remaining: 55 }));
    expect(p.total).toBe(100);
    expect(p.settled).toBe(45); // done + failed
    expect(p.remaining).toBe(55);
    expect(p.succeeded).toBe(40);
    expect(p.failed).toBe(5);
    expect(p.percent).toBe(45); // round(45/100 * 100)
  });

  it("rounds the percent to the nearest integer", async () => {
    const { replayJobProgress } = await import("../lib/replay-jobs");
    // 1 settled of 3 => 33.33% => 33
    const p = replayJobProgress(activeJob({ total: 3, done: 1, failed: 0, remaining: 2 }));
    expect(p.percent).toBe(33);
  });

  it("falls back to settled+remaining when the job total is 0", async () => {
    const { replayJobProgress } = await import("../lib/replay-jobs");
    // total unknown (0); derive from live counts: 6 done + 2 failed + 2 remaining = 10
    const p = replayJobProgress(activeJob({ total: 0, done: 6, failed: 2, remaining: 2 }));
    expect(p.total).toBe(10);
    expect(p.settled).toBe(8);
    expect(p.percent).toBe(80);
  });

  it("reports 0 percent when nothing is countable", async () => {
    const { replayJobProgress } = await import("../lib/replay-jobs");
    const p = replayJobProgress(activeJob({ total: 0, done: 0, failed: 0, remaining: 0 }));
    expect(p.total).toBe(0);
    expect(p.percent).toBe(0);
  });
});
