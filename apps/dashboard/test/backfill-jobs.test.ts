import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface PgCall {
  sql: string;
  params: unknown[];
}

const pgCalls: PgCall[] = [];
const pgResponses: Array<{ rows: unknown[]; rowCount?: number }> = [];

vi.mock("../lib/db", () => ({
  db: () => ({
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      pgCalls.push({ sql, params });
      const next = pgResponses.shift() ?? { rows: [], rowCount: 0 };
      return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length };
    }),
  }),
}));

vi.mock("../lib/ids", () => {
  let counter = 0;
  return {
    prefixedId: (prefix: string) => `${prefix}_${++counter}`,
  };
});

describe("backfill-jobs", () => {
  beforeEach(() => {
    pgCalls.length = 0;
    pgResponses.length = 0;
    process.env.CLICKHOUSE_URL = "https://ch.example";
  });
  afterEach(() => {
    delete process.env.CLICKHOUSE_URL;
    delete globalThis.__axelClickhouseFetch;
    vi.restoreAllMocks();
  });

  describe("previewBackfillCount", () => {
    it("returns 0 without ClickHouse configured", async () => {
      delete process.env.CLICKHOUSE_URL;
      const { previewBackfillCount } = await import("../lib/backfill-jobs");
      const n = await previewBackfillCount(
        "ws_1",
        "src_1",
        new Date("2026-05-10"),
        new Date("2026-05-17"),
      );
      expect(n).toBe(0);
    });

    it("issues a single COUNT() with date params and parses the result", async () => {
      globalThis.__axelClickhouseFetch = vi.fn(
        async () => new Response(JSON.stringify({ data: [{ n: "12345" }] }), { status: 200 }),
      );
      const { previewBackfillCount } = await import("../lib/backfill-jobs");
      const n = await previewBackfillCount(
        "ws_1",
        "src_1",
        new Date("2026-05-10T00:00:00Z"),
        new Date("2026-05-17T00:00:00Z"),
      );
      expect(n).toBe(12345);
      const call = (globalThis.__axelClickhouseFetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(String(call?.[1]?.body)).toMatch(/SELECT count\(\) AS n/);
    });
  });

  describe("createBackfillJob", () => {
    it("rejects inverted windows", async () => {
      const { createBackfillJob } = await import("../lib/backfill-jobs");
      await expect(
        createBackfillJob({
          workspaceId: "ws_1",
          routeId: "rt_1",
          sourceId: "src_1",
          since: new Date("2026-05-17"),
          until: new Date("2026-05-10"),
          requestedByUserId: "usr_1",
        }),
      ).rejects.toThrow("backfill_window_invalid");
    });

    it("inserts a pending job and an audit row", async () => {
      globalThis.__axelClickhouseFetch = vi.fn(
        async () => new Response(JSON.stringify({ data: [{ n: "500" }] }), { status: 200 }),
      );
      const { createBackfillJob } = await import("../lib/backfill-jobs");
      const result = await createBackfillJob({
        workspaceId: "ws_1",
        routeId: "rt_1",
        sourceId: "src_1",
        since: new Date("2026-05-10T00:00:00Z"),
        until: new Date("2026-05-17T00:00:00Z"),
        requestedByUserId: "usr_1",
      });
      expect(result.total_estimated).toBe(500);
      expect(result.id).toMatch(/^bfj_/);

      const inserts = pgCalls.filter((c) => c.sql.includes("INSERT INTO backfill_jobs"));
      expect(inserts).toHaveLength(1);
      // Job params: id, ws, route, src, since, until, total, max_inflight, user
      expect(inserts[0]?.params[1]).toBe("ws_1");
      expect(inserts[0]?.params[2]).toBe("rt_1");
      expect(inserts[0]?.params[3]).toBe("src_1");
      expect(inserts[0]?.params[6]).toBe(500); // total_estimated
      expect(inserts[0]?.params[7]).toBe(1000); // default max_inflight_replays

      const audit = pgCalls.find((c) => c.sql.includes("INSERT INTO audit_log"));
      // writeAudit param order: ws, actor, action, target_type, target_id, metadata
      expect(audit?.params[2]).toBe("route.backfill_job.queued");
      expect(audit?.params[4]).toBe("rt_1");
      const meta = JSON.parse(audit?.params[5] as string);
      expect(meta).toMatchObject({ source_id: "src_1", total_estimated: 500 });
    });

    it("tolerates ClickHouse preview failure by queuing with total_estimated=null", async () => {
      globalThis.__axelClickhouseFetch = vi.fn(async () => {
        throw new Error("network down");
      });
      const { createBackfillJob } = await import("../lib/backfill-jobs");
      const result = await createBackfillJob({
        workspaceId: "ws_1",
        routeId: "rt_1",
        sourceId: "src_1",
        since: new Date("2026-05-10T00:00:00Z"),
        until: new Date("2026-05-17T00:00:00Z"),
        requestedByUserId: "usr_1",
      });
      expect(result.total_estimated).toBe(0);
      const inserts = pgCalls.filter((c) => c.sql.includes("INSERT INTO backfill_jobs"));
      expect(inserts[0]?.params[6]).toBeNull(); // total_estimated stored as NULL
    });
  });

  describe("cancelBackfillJob", () => {
    it("returns false when no active job matches", async () => {
      pgResponses.push({ rows: [], rowCount: 0 });
      const { cancelBackfillJob } = await import("../lib/backfill-jobs");
      const result = await cancelBackfillJob("ws_1", "bfj_missing", "usr_1");
      expect(result).toBe(false);
    });

    it("transitions state to cancelled + writes audit on success", async () => {
      pgResponses.push({ rows: [], rowCount: 1 });
      pgResponses.push({ rows: [], rowCount: 1 });
      const { cancelBackfillJob } = await import("../lib/backfill-jobs");
      const result = await cancelBackfillJob("ws_1", "bfj_1", "usr_1");
      expect(result).toBe(true);
      expect(pgCalls[0]?.sql).toMatch(/UPDATE backfill_jobs/);
      expect(pgCalls[0]?.sql).toMatch(/state = 'cancelled'/);
      expect(pgCalls[1]?.sql).toMatch(/INSERT INTO audit_log/);
    });
  });

  describe("getActiveBackfillJob", () => {
    it("returns null when no active job", async () => {
      pgResponses.push({ rows: [] });
      const { getActiveBackfillJob } = await import("../lib/backfill-jobs");
      const result = await getActiveBackfillJob("ws_1", "rt_1");
      expect(result).toBeNull();
    });

    it("returns job + pending replay count", async () => {
      pgResponses.push({
        rows: [
          {
            id: "bfj_1",
            state: "running",
            total_estimated: 500,
            enqueued: 200,
            since: "2026-05-10",
            until: "2026-05-17",
            requested_at: "2026-05-18",
            started_at: "2026-05-18",
            finished_at: null,
            error_message: null,
          },
        ],
      });
      pgResponses.push({ rows: [{ n: "150" }] });
      const { getActiveBackfillJob } = await import("../lib/backfill-jobs");
      const result = await getActiveBackfillJob("ws_1", "rt_1");
      expect(result).toMatchObject({
        id: "bfj_1",
        state: "running",
        total_estimated: 500,
        enqueued: 200,
        pending_replays: 150,
      });
    });
  });
});
