import { afterEach, describe, expect, it, vi } from "vitest";
import { capturingPg } from "@axel/test-utils";
import type { Pool } from "pg";

// withPgRetry wraps every write in replay-job-completion.ts. We stub it to just
// run the fn once so the fake pool's responses drive the test deterministically
// (the real impl only retries on *transient* pg errors, which we never raise).
vi.mock("@axel/observability", () => ({
  withPgRetry: (_label: string, fn: () => Promise<unknown>) => fn(),
}));

import {
  advanceReplayJobOnTerminal,
  bumpReplayJobCounter,
  finishReplayJobIfComplete,
} from "../src/replay-job-completion.ts";
import { replayJobCompletionLink } from "../src/replay-job-completion-helpers.ts";

interface PgCall {
  sql: string;
  params: unknown[];
}

// Fake pg pool: each query() shifts the next queued response and records the
// call. A queued response may be an Error, in which case the query rejects with
// it (used for the 23505 dedup-swallow case).
function fakePool(responses: Array<{ rows: unknown[]; rowCount?: number } | Error>): {
  pool: Pool;
  calls: PgCall[];
} {
  const pg = capturingPg({ responses });
  return { pool: pg as unknown as Pool, calls: pg.calls };
}

const notifCalls = (calls: PgCall[]) =>
  calls.filter((c) => /INSERT INTO notifications/.test(c.sql));

describe("finishReplayJobIfComplete — atomic finish-once + notification", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does NOTHING (no notification) when pending/in_progress siblings remain", async () => {
    // The NOT EXISTS guard means the finish UPDATE matches zero rows.
    const { pool, calls } = fakePool([{ rows: [], rowCount: 0 }]);
    await finishReplayJobIfComplete(pool, "rpyjob_1");
    // Exactly one query (the finish UPDATE) and NO notification insert.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/UPDATE replay_jobs/);
    expect(calls[0]?.sql).toMatch(/NOT EXISTS/);
    expect(notifCalls(calls)).toHaveLength(0);
  });

  it("finishes + emits a deduped notification when none remain and the UPDATE returns a row", async () => {
    const { pool, calls } = fakePool([
      // finish-once UPDATE wins the race and RETURNs the recomputed counts.
      { rows: [{ workspace_id: "ws_1", succeeded_count: "40", failed_count: "2" }], rowCount: 1 },
      // notifications INSERT
      { rows: [], rowCount: 1 },
    ]);
    await finishReplayJobIfComplete(pool, "rpyjob_1");
    const notifs = notifCalls(calls);
    expect(notifs).toHaveLength(1);
    const notif = notifs[0];
    // kind literal lives in the SQL; severity + filtered link are params.
    expect(notif?.sql).toMatch(/'replay_job_complete'/);
    expect(notif?.sql).not.toMatch(/'\/deliveries'/);
    // failed>0 => 'warning'; deep-link the failed stream; dedup_key namespaced by job id.
    expect(notif?.params).toContain("warning");
    expect(notif?.params).toContain("/workspaces/ws_1/deliveries?status=failed");
    expect(notif?.params).toContain("replay_job_complete:rpyjob_1");
    // The recomputed authoritative numbers feed the title (40 succeeded, 2 failing).
    const titleParam = notif?.params.find(
      (p) => typeof p === "string" && p.startsWith("Replay finished:"),
    );
    expect(titleParam).toBe("Replay finished: 40 succeeded, 2 still failing");
  });

  it("emits NO notification when the finish UPDATE returns zero rows (lost the race)", async () => {
    // Another worker/replica already finished the job: finished_at IS NOT NULL,
    // so this racer's UPDATE matches nothing.
    const { pool, calls } = fakePool([{ rows: [], rowCount: 0 }]);
    await finishReplayJobIfComplete(pool, "rpyjob_1");
    expect(notifCalls(calls)).toHaveLength(0);
  });

  it("swallows a 23505 dedup error from the notification INSERT (second safety net)", async () => {
    const { pool } = fakePool([
      { rows: [{ workspace_id: "ws_1", succeeded_count: "5", failed_count: "0" }], rowCount: 1 },
      new Error(
        'duplicate key value violates unique constraint "notifications_active_dedup_idx"',
      ),
    ]);
    // Must resolve, not reject — the dedup error is the intended outcome.
    await expect(finishReplayJobIfComplete(pool, "rpyjob_1")).resolves.toBeUndefined();
  });

  it("info-severity + success-only title when nothing still failed", async () => {
    const { pool, calls } = fakePool([
      { rows: [{ workspace_id: "ws_1", succeeded_count: "1850", failed_count: "0" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    await finishReplayJobIfComplete(pool, "rpyjob_1");
    const notif = notifCalls(calls)[0];
    expect(notif?.params).toContain("info");
    expect(notif?.params).toContain("/workspaces/ws_1/deliveries");
    expect(notif?.params).not.toContain("/workspaces/ws_1/deliveries?status=failed");
    const titleParam = notif?.params.find(
      (p) => typeof p === "string" && p.startsWith("Replay finished:"),
    );
    expect(titleParam).toBe("Replay finished: 1,850 succeeded");
  });
});

describe("replayJobCompletionLink", () => {
  it("filters to failed deliveries when the job still has failures", () => {
    expect(replayJobCompletionLink("ws_1", 76)).toBe(
      "/workspaces/ws_1/deliveries?status=failed",
    );
  });

  it("opens the deliveries log without a status filter when everything succeeded", () => {
    expect(replayJobCompletionLink("ws_1", 0)).toBe("/workspaces/ws_1/deliveries");
  });

  it("encodes unusual workspace ids", () => {
    expect(replayJobCompletionLink("ws/with spaces", 1)).toBe(
      "/workspaces/ws%2Fwith%20spaces/deliveries?status=failed",
    );
  });
});

describe("bumpReplayJobCounter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("stamps 'running' (idempotent on pending) then bumps the outcome counter", async () => {
    const { pool, calls } = fakePool([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 1 },
    ]);
    await bumpReplayJobCounter(pool, "rpyjob_1", "failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toMatch(/state = 'running'/);
    expect(calls[0]?.sql).toMatch(/AND state = 'pending'/);
    expect(calls[1]?.sql).toMatch(/succeeded_count = succeeded_count/);
    expect(calls[1]?.params).toEqual(["rpyjob_1", "failed"]);
  });
});

describe("advanceReplayJobOnTerminal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("never throws even if a write fails (best-effort; must not break delivery)", async () => {
    const { pool } = fakePool([new Error("replay_jobs does not exist")]);
    await expect(advanceReplayJobOnTerminal(pool, "rpyjob_1", "succeeded")).resolves.toBeUndefined();
  });
});
