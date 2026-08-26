import { afterEach, describe, expect, it, vi } from "vitest";

const { dbMock, safeDashboardFetchMock } = vi.hoisted(() => ({
  dbMock: vi.fn(),
  safeDashboardFetchMock: vi.fn(),
}));

vi.mock("../lib/db", () => ({ db: dbMock }));
vi.mock("../lib/safe-egress", () => ({ safeDashboardFetch: safeDashboardFetchMock }));

import { runDashboardPullSync } from "../lib/pull-sync";

describe("dashboard SaaS pull pagination", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    delete process.env.DASHBOARD_PULL_SYNC_MAX_PAGES;
  });

  it("carries the global watermark across three capped newest-first Stripe windows", async () => {
    process.env.DASHBOARD_PULL_SYNC_MAX_PAGES = "1";
    const state = new Map<string, {
      cursor: unknown;
      resume: string | null;
      pending: unknown;
      updatedAt: string;
    }>();
    const runStatuses: string[] = [];
    const storedSummaries: string[] = [];
    const databaseQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM pull_sources ps")) {
          return {
            rows: [{
              id: "src_stripe",
              workspace_id: "ws_1",
              name: "Stripe",
              type: "stripe",
              config: {
                api_key: "sk_test",
                ingest_token: "ingest-token",
                streams: [{ name: "customers", cursor_field: "created", sync_mode: "incremental" }],
              },
              credentials_ref: null,
              status: "active",
              ingest_status: "active",
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("FROM pull_source_stream_state")) {
          return {
            rows: [...state.entries()].map(([stream, value]) => ({
              stream,
              cursor: value.cursor,
              resume_page_cursor: value.resume,
              pending_high_watermark: value.pending,
              updated_at: value.updatedAt,
            })),
            rowCount: state.size,
          };
        }
        if (sql.includes("INSERT INTO pull_source_stream_state")) {
          state.set(String(params[1]), {
            cursor: JSON.parse(String(params[2])),
            resume: params[3] == null ? null : String(params[3]),
            pending: JSON.parse(String(params[4])),
            updatedAt: String(params[5]),
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes("UPDATE pull_sync_runs") && sql.includes("SET status = $2")) {
          runStatuses.push(String(params[1]));
          storedSummaries.push(String(params[5]));
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      });
    const lockClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        if (sql.includes("pg_advisory_unlock")) return { rows: [] };
        return databaseQuery(sql, params);
      }),
      release: vi.fn(),
    };
    const pool = {
      connect: vi.fn(async () => lockClient),
      query: databaseQuery,
    };
    dbMock.mockReturnValue(pool);

    const stripeUrls: string[] = [];
    const ingestFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init).toMatchObject({
        redirect: "manual",
        headers: expect.objectContaining({ "x-axel-token": "ingest-token" }),
      });
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", ingestFetch);
    safeDashboardFetchMock.mockImplementation(async (url: string) => {
      stripeUrls.push(url);
      if (url.includes("created%5Bgt%5D=1001")) {
        return Response.json({ data: [], has_more: false });
      }
      if (url.includes("starting_after=cus_new")) {
        return Response.json({ data: [{ id: "cus_mid", created: 800 }], has_more: true });
      }
      if (url.includes("starting_after=cus_mid")) {
        return Response.json({ data: [{ id: "cus_old", created: 600 }], has_more: false });
      }
      return Response.json({ data: [{ id: "cus_new", created: 1000 }], has_more: true });
    });

    const first = await runDashboardPullSync({
      sourceId: "src_stripe",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    });
    expect(first.streams[0]).toMatchObject({
      status: "partial",
      cursor: null,
      error: "max_pages_per_stream_reached",
    });
    expect(state.get("customers")).toMatchObject({
      cursor: null,
      resume: "cus_new",
      pending: { value: 1000 },
    });

    const second = await runDashboardPullSync({
      sourceId: "src_stripe",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    });
    expect(second.streams[0]?.status).toBe("partial");
    expect(state.get("customers")).toMatchObject({
      cursor: null,
      resume: "cus_mid",
      pending: { value: 1000 },
    });

    const third = await runDashboardPullSync({
      sourceId: "src_stripe",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    });
    expect(third.streams[0]).toMatchObject({ status: "success", cursor: { value: 1000 } });
    expect(state.get("customers")?.resume).toBeNull();
    expect(state.get("customers")?.pending).toBeNull();

    const fourth = await runDashboardPullSync({
      sourceId: "src_stripe",
      workspaceId: "ws_1",
      actorUserId: "usr_1",
    });
    expect(fourth.streams[0]).toMatchObject({ status: "success", records: 0, cursor: { value: 1000 } });
    expect(stripeUrls[1]).toContain("starting_after=cus_new");
    expect(stripeUrls[2]).toContain("starting_after=cus_mid");
    expect(stripeUrls[3]).toContain("created%5Bgt%5D=1001");
    expect(runStatuses).toEqual(["partial", "partial", "success", "success"]);
    expect(storedSummaries).toHaveLength(4);
    expect(storedSummaries.every((summary) => summary.includes("cursor_present"))).toBe(true);
    expect(storedSummaries.every((summary) => !summary.includes('"cursor":'))).toBe(true);
    expect(ingestFetch).toHaveBeenCalledTimes(3);
    expect(lockClient.release).toHaveBeenCalledTimes(4);
  });
});
