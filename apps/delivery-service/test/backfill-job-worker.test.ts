import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { advanceJob, runBackfillWorkerOnce } from "../src/backfill-job-worker.ts";

interface PgCall {
  sql: string;
  params: unknown[];
}

interface JobState {
  id: string;
  workspace_id: string;
  route_id: string;
  source_id: string;
  since: string;
  until: string;
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  cursor_received_at: string | null;
  cursor_event_id: string | null;
  max_inflight_replays: number;
  enqueued: string;
  pending_replays: number;
  error_message?: string;
}

interface FakeOptions {
  jobs: JobState[];
  fetchPages: Array<Array<{ event_id: string; r2_key: string; received_at_text: string }>>;
}

function fakeWorkerDeps(opts: FakeOptions) {
  const pgCalls: PgCall[] = [];
  const jobsById = new Map(opts.jobs.map((j) => [j.id, { ...j }]));
  const fetchPages = [...opts.fetchPages];

  const txCalls: PgCall[] = [];
  const fakeClient = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      txCalls.push({ sql, params });
      // node-pg sets rowCount to the number of rows actually inserted (after
      // ON CONFLICT DO NOTHING). The bulk INSERT binds 10 params per row.
      if (/^INSERT INTO replay_requests/.test(sql)) {
        return { rows: [], rowCount: Math.floor((params?.length ?? 0) / 10) };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      pgCalls.push({ sql, params });
      if (sql.includes("FROM backfill_jobs") && sql.includes("state IN ('pending', 'running')")) {
        const rows = Array.from(jobsById.values())
          .filter((j) => j.state === "pending" || j.state === "running")
          .slice(0, (params[0] as number) ?? 4);
        return { rows, rowCount: rows.length };
      }
      if (sql.includes("SELECT state FROM backfill_jobs WHERE id")) {
        const j = jobsById.get(params[0] as string);
        return { rows: j ? [{ state: j.state }] : [], rowCount: j ? 1 : 0 };
      }
      if (sql.includes("FROM replay_requests") && sql.includes("count(*)")) {
        const j = jobsById.get(params[0] as string);
        return { rows: [{ n: String(j?.pending_replays ?? 0) }], rowCount: 1 };
      }
      if (sql.includes("UPDATE backfill_jobs") && sql.includes("'done'")) {
        const j = jobsById.get(params[0] as string);
        if (j && (j.state === "pending" || j.state === "running")) j.state = "done";
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("UPDATE backfill_jobs") && sql.includes("'failed'")) {
        const j = jobsById.get(params[0] as string);
        if (j && (j.state === "pending" || j.state === "running")) {
          j.state = "failed";
          j.error_message = params[1] as string;
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    connect: vi.fn(async () => fakeClient),
  } as unknown as Pool;

  const fetchImpl = vi.fn(async (_url: unknown) => {
    const next = fetchPages.shift() ?? [];
    return new Response(JSON.stringify({ data: next }), { status: 200 });
  }) as unknown as typeof fetch;

  return {
    deps: {
      pool,
      clickhouse: { url: "https://ch.example" },
      fetchImpl,
    },
    pgCalls,
    txCalls,
    jobsById,
    fetchImpl,
    fakeClient,
  };
}

const baseJob: JobState = {
  id: "bfj_1",
  workspace_id: "ws_1",
  route_id: "rt_1",
  source_id: "src_1",
  since: "2026-05-10T00:00:00Z",
  until: "2026-05-17T00:00:00Z",
  state: "pending",
  cursor_received_at: null,
  cursor_event_id: null,
  max_inflight_replays: 100,
  enqueued: "0",
  pending_replays: 0,
};

describe("backfill-job-worker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throttles when pending replays >= max_inflight_replays", async () => {
    const { deps, fetchImpl } = fakeWorkerDeps({
      jobs: [{ ...baseJob, pending_replays: 100 }], // at the cap
      fetchPages: [],
    });
    const result = await advanceJob(deps, { ...baseJob, pending_replays: 100 } as never);
    expect(result).toBe("throttled");
    expect(fetchImpl).not.toHaveBeenCalled(); // no CH query when throttled
  });

  it("marks job done when ClickHouse returns no events", async () => {
    const { deps, fetchImpl, jobsById } = fakeWorkerDeps({
      jobs: [{ ...baseJob }],
      fetchPages: [[]],
    });
    const result = await advanceJob(deps, baseJob as never);
    expect(result).toBe("done");
    expect(jobsById.get("bfj_1")?.state).toBe("done");

    const url = new URL(String(vi.mocked(fetchImpl).mock.calls[0]?.[0]));
    expect(url.searchParams.get("max_execution_time")).toBe("10");
    expect(url.searchParams.get("max_memory_usage")).toBe("536870912");
    expect(url.searchParams.get("max_threads")).toBe("2");
    expect(url.searchParams.get("max_result_rows")).toBe("10000");
    expect(url.searchParams.get("result_overflow_mode")).toBe("break");
  });

  it("enqueues a batch, advances cursor, and transactions the INSERT+UPDATE together", async () => {
    const events = [
      { event_id: "e1", r2_key: "events/ws_1/e1.json", received_at_text: "2026-05-10 00:00:01.000" },
      { event_id: "e2", r2_key: "events/ws_1/e2.json", received_at_text: "2026-05-10 00:00:02.000" },
    ];
    const { deps, txCalls } = fakeWorkerDeps({
      jobs: [{ ...baseJob }],
      fetchPages: [events],
    });
    const result = await advanceJob(deps, baseJob as never);
    expect(result).toBe("advanced");

    // Transaction shape: BEGIN, INSERT, UPDATE cursor, COMMIT
    const sqls = txCalls.map((c) => c.sql.replace(/\s+/g, " ").trim().slice(0, 60));
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls[1]).toMatch(/^INSERT INTO replay_requests/);
    expect(sqls[2]).toMatch(/^UPDATE backfill_jobs/);
    expect(sqls[3]).toBe("COMMIT");

    // INSERT carries 10 params per row × 2 rows = 20 params
    expect(txCalls[1]?.params).toHaveLength(20);
    // Per-row: id, ws, event, src, r2, "route", route_id, null dest, "pending", job_id
    // Row 0 base 0; check scope, route_id, dest, state, backfill_job_id
    expect(txCalls[1]?.params[5]).toBe("route");
    expect(txCalls[1]?.params[6]).toBe("rt_1");
    expect(txCalls[1]?.params[7]).toBeNull();
    expect(txCalls[1]?.params[8]).toBe("pending");
    expect(txCalls[1]?.params[9]).toBe("bfj_1");

    // Cursor advance uses the LAST row's received_at + event_id
    const cursorParams = txCalls[2]?.params ?? [];
    expect(cursorParams[0]).toBe("bfj_1");
    expect(cursorParams[1]).toBe("2026-05-10T00:00:02.000Z"); // ISO-converted
    expect(cursorParams[2]).toBe("e2");
    expect(cursorParams[3]).toBe(2); // increment by 2
  });

  it("uses cursor-based pagination on subsequent ticks", async () => {
    const events = [
      { event_id: "e3", r2_key: "k", received_at_text: "2026-05-10 00:00:03.000" },
    ];
    const job: JobState = {
      ...baseJob,
      state: "running",
      cursor_received_at: "2026-05-10T00:00:02.000Z",
      cursor_event_id: "e2",
    };
    const { deps, fetchImpl } = fakeWorkerDeps({
      jobs: [job],
      fetchPages: [events],
    });
    await advanceJob(deps, job as never);
    // The fetch call body (SQL) should include the cursor comparison
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[0];
    expect(lastCall).toBeDefined();
    const init = lastCall?.[1] as RequestInit | undefined;
    expect(String(init?.body)).toMatch(/received_at > parseDateTime64BestEffort.*cursor_rcv/);
    expect(String(init?.body)).toMatch(/event_id > \{cursor_evt:String\}/);
  });

  it("respects cancellation between ticks", async () => {
    const { deps, jobsById } = fakeWorkerDeps({
      jobs: [{ ...baseJob, state: "cancelled" }],
      fetchPages: [],
    });
    const result = await advanceJob(deps, baseJob as never);
    expect(result).toBe("cancelled");
    // Cancelled job is left in cancelled state — worker doesn't touch it
    expect(jobsById.get("bfj_1")?.state).toBe("cancelled");
  });

  it("marks job failed when ClickHouse query throws", async () => {
    const { deps, jobsById, fetchImpl } = fakeWorkerDeps({
      jobs: [{ ...baseJob }],
      fetchPages: [],
    });
    (fetchImpl as ReturnType<typeof vi.fn>).mockReset();
    (fetchImpl as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response("server burning", { status: 500 }) as never,
    );
    const result = await advanceJob(deps, baseJob as never);
    expect(result).toBe("failed");
    expect(jobsById.get("bfj_1")?.state).toBe("failed");
    expect(jobsById.get("bfj_1")?.error_message).toMatch(/clickhouse_500/);
  });

  it("does not read or retain a failed ClickHouse response body", async () => {
    const { deps, jobsById, fetchImpl } = fakeWorkerDeps({
      jobs: [{ ...baseJob }],
      fetchPages: [],
    });
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn(async () => "payload=customer-secret");
    (fetchImpl as ReturnType<typeof vi.fn>).mockReset();
    (fetchImpl as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      body: { cancel },
      text,
    } as never);

    const result = await advanceJob(deps, baseJob as never);

    expect(result).toBe("failed");
    expect(jobsById.get("bfj_1")?.error_message).toBe("clickhouse_400");
    expect(cancel).toHaveBeenCalledOnce();
    expect(text).not.toHaveBeenCalled();
  });

  it("rolls back transaction on bulk-INSERT failure and marks job failed", async () => {
    const events = [
      { event_id: "e1", r2_key: "k", received_at_text: "2026-05-10 00:00:01.000" },
    ];
    const { deps, jobsById, fakeClient, txCalls } = fakeWorkerDeps({
      jobs: [{ ...baseJob }],
      fetchPages: [events],
    });
    // Make the INSERT fail
    (fakeClient.query as ReturnType<typeof vi.fn>).mockImplementation(
      async (sql: string, params: unknown[] = []) => {
        txCalls.push({ sql, params });
        if (sql.includes("INSERT INTO replay_requests")) {
          throw new Error("duplicate key");
        }
        return { rows: [], rowCount: 0 };
      },
    );
    const result = await advanceJob(deps, baseJob as never);
    expect(result).toBe("failed");
    expect(jobsById.get("bfj_1")?.state).toBe("failed");
    // ROLLBACK must have been called
    expect(txCalls.some((c) => c.sql === "ROLLBACK")).toBe(true);
  });

  it("runBackfillWorkerOnce returns a per-tick summary", async () => {
    const { deps } = fakeWorkerDeps({
      jobs: [
        { ...baseJob, id: "bfj_a", pending_replays: 100 }, // throttled
        { ...baseJob, id: "bfj_b" }, // empty → done
      ],
      fetchPages: [[]], // for bfj_b
    });
    const summary = await runBackfillWorkerOnce(deps);
    expect(summary).toEqual({
      jobs: 2,
      advanced: 0,
      throttled: 1,
      finished: 1,
    });
  });
});
