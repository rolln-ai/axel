import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturingPg, fakeSession } from "@axel/test-utils";

// STYLE B (module mock): exercise the requestReplayAllUnresolved server action
// against a capturing fake { query } injected via the mocked db/withTransaction,
// asserting the SQL the shared enqueueReplays tail emits and the params it
// binds. No real Postgres.

const pg = capturingPg({
  // The replay billing gate (computePlanState) runs before the main work.
  // Answer it with an "accept" row (free plan, ok status, zero usage) WITHOUT
  // consuming the scripted FIFO, so each test's response script stays aligned.
  intercept: (sql) =>
    /workspace_usage_period/.test(sql) && /FROM workspaces/.test(sql)
      ? {
          rows: [{ workspace_id: "ws_1", plan: "free", billing_status: "ok", total_tasks: "0" }],
          rowCount: 1,
        }
      : undefined,
});
const { calls: pgCalls, responses: pgResponses } = pg;

// The action's whole body runs inside withTransaction; dbModule() hands the
// callback the same capturing client so createReplayJob's INSERT + the tagging
// UPDATE land in pgCalls, and a thrown error mirrors real txn rollback.
vi.mock("../lib/db", () => pg.dbModule());

// Deterministic ids: enqueueReplays calls prefixedId("rpy") per inserted row
// and createReplayJob calls prefixedId("rpyjob").
vi.mock("../lib/ids", () => {
  let counter = 0;
  return {
    prefixedId: (prefix: string) => `${prefix}_${++counter}`,
    slugifyWorkspaceName: (s: string) => s,
  };
});

// Authenticated owner on an active workspace so the role/status guards pass.
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

/** ids the mocked prefixedId minted for the INSERT (the parallel array param). */
function insertedIds(): string[] {
  const insert = pgCalls.find((c) => /INSERT INTO replay_requests/.test(c.sql));
  return (insert?.params[3] as string[]) ?? [];
}

describe("requestReplayAllUnresolved — tracked replay job", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
  });

  it("creates a replay_jobs row and tags the inserted replay_requests when queued > 0", async () => {
    // Responses, in the order enqueueReplays queries inside the transaction:
    // (1) candidate evaluation SELECT → 3 insertable candidates
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_a" }),
        candidate({ event_id: "evt_b" }),
        candidate({ event_id: "evt_c" }),
      ],
    });
    // (2) INSERT ... RETURNING id
    pgResponses.push({ rows: [{ id: "x" }, { id: "y" }, { id: "z" }], rowCount: 3 });
    // (3) createReplayJob INSERT INTO replay_jobs
    pgResponses.push({ rows: [], rowCount: 1 });
    // (4) UPDATE replay_requests SET replay_job_id = $1 WHERE id = ANY($2)
    pgResponses.push({ rows: [], rowCount: 3 });
    // (5) INSERT INTO audit_log
    pgResponses.push({ rows: [], rowCount: 1 });

    const { requestReplayAllUnresolved } = await import("../lib/replay-actions");
    const result = await requestReplayAllUnresolved(
      {},
      formData({ reason: "replay_all_unresolved" }),
    );

    // 1) The candidate CTE stays per-caller (DISTINCT ON pair dedupe), while
    //    the mute + in-flight guards live in the shared tail.
    const evaluate = pgCalls.find((c) => /WITH candidates AS/.test(c.sql));
    expect(evaluate).toBeDefined();
    expect(evaluate?.sql).toMatch(/DISTINCT ON \(dl\.event_id, dl\.route_id\)/);
    expect(evaluate?.sql).toMatch(/dead_letter_mutes/);
    expect(evaluate?.sql).toMatch(/m\.fingerprint = c\.fingerprint/);
    expect(evaluate?.sql).toMatch(/state IN \('pending', 'in_progress'\)/);

    // 2) The INSERT binds app-generated rpy_ ids (RETURNING id).
    const insert = pgCalls.find((c) => /INSERT INTO replay_requests/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert?.sql).toMatch(/RETURNING id/);
    const ids = insertedIds();
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(id).toMatch(/^rpy_/);

    // 3) Exactly one replay_jobs row is created, carrying the tracking job id +
    //    the queued count as its total.
    const jobInserts = pgCalls.filter((c) => /INSERT INTO replay_jobs/.test(c.sql));
    expect(jobInserts).toHaveLength(1);
    expect(jobInserts[0]?.params[0]).toMatch(/^rpyjob_/); // id
    expect(jobInserts[0]?.params[1]).toBe("ws_1"); // workspace_id
    expect(jobInserts[0]?.params[2]).toBe("usr_1"); // requested_by_user_id
    expect(jobInserts[0]?.params[3]).toBe("replay_all_unresolved"); // reason
    expect(jobInserts[0]?.params[4]).toBeNull(); // reason_filter
    expect(jobInserts[0]?.params[5]).toBe(3); // total = queued
    expect(jobInserts[0]?.sql).toMatch(/'pending'/);

    // 4) The tagging UPDATE stamps the job id onto exactly the inserted rows.
    const tagUpdate = pgCalls.find((c) =>
      /UPDATE replay_requests SET replay_job_id/.test(c.sql),
    );
    expect(tagUpdate).toBeDefined();
    expect(tagUpdate?.sql).toMatch(/id = ANY\(\$2::text\[\]\)/);
    expect(tagUpdate?.params[0]).toBe(jobInserts[0]?.params[0]);
    expect(tagUpdate?.params[1]).toEqual(ids);

    // 5) Audit row records the queued count + job id in its metadata.
    const audit = pgCalls.find((c) => /INSERT INTO audit_log/.test(c.sql));
    expect(audit).toBeDefined();
    // writeAudit param order: ws, actor, action, target_type, target_id, metadata
    expect(audit?.params[2]).toBe("replay.requested_all_unresolved");
    const meta = JSON.parse(audit?.params[5] as string);
    expect(meta).toMatchObject({ queued: 3, reason: "replay_all_unresolved" });
    expect(meta.replay_job_id).toBe(jobInserts[0]?.params[0]);

    // Ordering: the job row is inserted BEFORE the tagging UPDATE (FK safety).
    const jobIdx = pgCalls.findIndex((c) => /INSERT INTO replay_jobs/.test(c.sql));
    const tagIdx = pgCalls.findIndex((c) => /UPDATE replay_requests SET replay_job_id/.test(c.sql));
    expect(jobIdx).toBeGreaterThanOrEqual(0);
    expect(jobIdx).toBeLessThan(tagIdx);

    // Notice references the queued count + points at Deliveries for progress.
    expect(result.notice).toMatch(/3 replay request/);
    expect(result.notice).toMatch(/Deliveries/);
    expect(result.error).toBeUndefined();
  });

  it("skips muted fingerprints and reports the muted-skip count", async () => {
    // 1 insertable + 2 muted candidates.
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_a" }),
        candidate({ event_id: "evt_b", is_muted: true }),
        candidate({ event_id: "evt_c", is_muted: true }),
      ],
    });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 }); // INSERT
    pgResponses.push({ rows: [], rowCount: 1 }); // createReplayJob
    pgResponses.push({ rows: [], rowCount: 1 }); // tag UPDATE
    pgResponses.push({ rows: [], rowCount: 1 }); // audit

    const { requestReplayAllUnresolved } = await import("../lib/replay-actions");
    const result = await requestReplayAllUnresolved({}, formData({ reason: "replay_all_unresolved" }));

    // Muted candidates never reach the INSERT.
    const insert = pgCalls.find((c) => /INSERT INTO replay_requests/.test(c.sql));
    expect(insert?.params[4]).toEqual(["evt_a"]);

    // The notice queues the unmuted row AND tells the operator 2 were muted.
    expect(result.notice).toMatch(/Queued 1 replay request/);
    expect(result.notice).toMatch(/2 muted fingerprints were skipped/);
  });

  it("reports muted-only when every matching unresolved failure is muted", async () => {
    pgResponses.push({
      rows: [1, 2, 3, 4, 5].map((n) => candidate({ event_id: `evt_${n}`, is_muted: true })),
    });
    pgResponses.push({ rows: [{ count: "0" }], rowCount: 1 }); // active-in-flight count = 0

    const { requestReplayAllUnresolved } = await import("../lib/replay-actions");
    const result = await requestReplayAllUnresolved({}, formData({ reason: "replay_all_unresolved" }));

    expect(pgCalls.filter((c) => /INSERT INTO replay_jobs/.test(c.sql))).toHaveLength(0);
    expect(result.notice).toMatch(/5 matching unresolved failures are muted/);
    expect(result.notice).not.toMatch(/No unresolved failures/);
  });

  it("passes a non-null reason_filter into the job row", async () => {
    pgResponses.push({ rows: [candidate({ event_id: "evt_x" })] });
    pgResponses.push({ rows: [{ id: "x" }], rowCount: 1 });
    pgResponses.push({ rows: [], rowCount: 1 });
    pgResponses.push({ rows: [], rowCount: 1 });
    pgResponses.push({ rows: [], rowCount: 1 });

    const { requestReplayAllUnresolved } = await import("../lib/replay-actions");
    await requestReplayAllUnresolved(
      {},
      formData({ reason: "replay_all_unresolved", reason_filter: "destination_timeout" }),
    );

    const jobInsert = pgCalls.find((c) => /INSERT INTO replay_jobs/.test(c.sql));
    expect(jobInsert?.params[4]).toBe("destination_timeout"); // reason_filter
    expect(jobInsert?.params[5]).toBe(1); // total
  });

  it("does NOT create a replay_jobs row when nothing is queued", async () => {
    // Candidate evaluation finds nothing at all...
    pgResponses.push({ rows: [] });
    // ...then the queued===0 branch runs the "already active" count SELECT.
    pgResponses.push({ rows: [{ count: "0" }], rowCount: 1 });

    const { requestReplayAllUnresolved } = await import("../lib/replay-actions");
    const result = await requestReplayAllUnresolved(
      {},
      formData({ reason: "replay_all_unresolved" }),
    );

    // No insert, no tracking job, no tagging UPDATE, no audit row when there
    // is no work.
    expect(pgCalls.filter((c) => /INSERT INTO replay_requests/.test(c.sql))).toHaveLength(0);
    expect(pgCalls.filter((c) => /INSERT INTO replay_jobs/.test(c.sql))).toHaveLength(0);
    expect(pgCalls.filter((c) => /UPDATE replay_requests SET replay_job_id/.test(c.sql))).toHaveLength(0);
    expect(pgCalls.filter((c) => /INSERT INTO audit_log/.test(c.sql))).toHaveLength(0);
    expect(result.notice).toMatch(/No unresolved failures to replay/);
  });

  it("surfaces 'already queued' when work exists but is in flight", async () => {
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_a", is_in_flight: true }),
        candidate({ event_id: "evt_b", is_in_flight: true }),
      ],
    });
    pgResponses.push({ rows: [{ count: "12" }], rowCount: 1 });

    const { requestReplayAllUnresolved } = await import("../lib/replay-actions");
    const result = await requestReplayAllUnresolved(
      {},
      formData({ reason: "replay_all_unresolved" }),
    );

    expect(pgCalls.filter((c) => /INSERT INTO replay_jobs/.test(c.sql))).toHaveLength(0);
    expect(result.notice).toMatch(/12 replay request.*already queued or running/);
  });
});

describe("requestInvestigationReplayAll — tracked replay job", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
  });

  it("creates and tags a job for the investigation's source and failure group", async () => {
    // (1) anchor lookup
    pgResponses.push({
      rows: [{ source_id: "src_1", reason: "router_processing_failed" }],
    });
    // (2) candidate evaluation
    pgResponses.push({
      rows: [
        candidate({ event_id: "evt_a", failure_reason: "router_processing_failed" }),
        candidate({ event_id: "evt_b", failure_reason: "router_processing_failed" }),
      ],
    });
    pgResponses.push({ rows: [{ id: "x" }, { id: "y" }], rowCount: 2 }); // INSERT
    pgResponses.push({ rows: [], rowCount: 1 }); // replay_jobs
    pgResponses.push({ rows: [], rowCount: 2 }); // tag requests
    pgResponses.push({ rows: [], rowCount: 1 }); // audit

    const { requestInvestigationReplayAll } = await import("../lib/replay-actions");
    const result = await requestInvestigationReplayAll(
      {},
      formData({
        dead_letter_id: "283837",
        reason: "investigation_replay_all",
      }),
    );

    // The candidate SELECT scopes to the anchor's (source_id, reason).
    const evaluate = pgCalls.find((c) => /WITH candidates AS/.test(c.sql));
    expect(evaluate).toBeDefined();
    expect(evaluate?.params).toEqual(["ws_1", "src_1", "router_processing_failed", "ws_1"]);

    const ids = insertedIds();
    expect(ids).toHaveLength(2);

    const jobInsert = pgCalls.find((c) => /INSERT INTO replay_jobs/.test(c.sql));
    expect(jobInsert?.params[1]).toBe("ws_1");
    expect(jobInsert?.params[3]).toBe("investigation_replay_all");
    expect(jobInsert?.params[4]).toBe("router_processing_failed");
    expect(jobInsert?.params[5]).toBe(2);

    const tagUpdate = pgCalls.find((c) =>
      /UPDATE replay_requests SET replay_job_id/.test(c.sql),
    );
    expect(tagUpdate?.params[1]).toEqual(ids);

    const audit = pgCalls.find(
      (c) =>
        /INSERT INTO audit_log/.test(c.sql) &&
        c.params[2] === "replay.requested_investigation",
    );
    const metadata = JSON.parse(audit?.params[5] as string);
    expect(metadata).toMatchObject({
      dead_letter_id: "283837",
      source_id: "src_1",
      reason: "router_processing_failed",
      queued: 2,
    });
    expect(metadata.replay_job_id).toBe(tagUpdate?.params[0]);
    expect(result.notice).toMatch(/Progress will update below/);
  });
});
