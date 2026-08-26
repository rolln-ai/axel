import { afterEach, describe, expect, it, vi } from "vitest";
import { PullBatchError, runActivePullSources } from "../src/index";

describe("pull worker scheduling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("selects only active pull rows with an active ingest shadow source", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));

    await runActivePullSources({ pool: { query } as never });

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("JOIN sources ingest_source");
    expect(sql).toContain("ingest_source.status = 'active'");
    expect(sql).toContain("ps.status = 'active'");
    expect(sql).toContain("MAX(history.started_at)");
    expect(sql).toContain("ASC NULLS FIRST");
    expect(sql).toContain("ps.updated_at ASC");
    expect(sql).toContain("ps.id ASC");
  });

  it("silently skips a source when a dashboard sync already holds its lock", async () => {
    const row = {
      id: "src_busy",
      workspace_id: "ws_1",
      name: "Busy source",
      type: "stripe",
      config: {},
      credentials_ref: null,
    };
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const lockClient = {
      query: vi.fn(async () => ({ rows: [{ acquired: false }] })),
      release: vi.fn(),
    };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const summaries = await runActivePullSources({
      pool: { query, connect: async () => lockClient } as never,
    });

    expect(summaries).toEqual([]);
    expect(error).not.toHaveBeenCalled();
    expect(lockClient.release).toHaveBeenCalledTimes(1);
  });

  it("attempts the full batch, then aggregates pre-run and failed-stream outcomes", async () => {
    const rows = [
      sourceRow("src_pre", "chargebee"),
      sourceRow("src_failed", "stripe"),
      sourceRow("src_ok", "shopify"),
    ];
    const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const connect = vi.fn(async () => ({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        clientQueries.push({ sql, params });
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    }));
    const failedRead = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    const successfulRead = vi.fn(async () => ({ records: [], highWatermark: null }));
    const connectors = new Map([
      ["stripe", connector("stripe", failedRead)],
      ["shopify", connector("shopify", successfulRead)],
      // No Chargebee connector: src_pre fails during setup after its run row.
    ]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let aggregate: PullBatchError | undefined;
    try {
      await runActivePullSources({
        pool: { query, connect } as never,
        connectors: connectors as never,
        recordSink: { write: vi.fn(async () => undefined) },
      });
    } catch (err) {
      aggregate = err as PullBatchError;
    }

    expect(aggregate).toBeInstanceOf(PullBatchError);
    expect(aggregate).toMatchObject({
      attempted: 3,
      failures: [
        { sourceId: "src_pre", kind: "pre_run" },
        { sourceId: "src_failed", kind: "stream" },
      ],
    });
    expect(aggregate?.summaries.map((summary) => ({
      sourceId: summary.source_id,
      status: summary.streams[0]?.status,
    }))).toEqual([
      { sourceId: "src_failed", status: "failed" },
      { sourceId: "src_ok", status: "success" },
    ]);
    expect(failedRead).toHaveBeenCalledOnce();
    expect(successfulRead).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(3);

    const preRunInsert = clientQueries.find((call) =>
      call.sql.includes("INSERT INTO pull_sync_runs") && call.params[1] === "src_pre"
    );
    expect(preRunInsert).toBeDefined();
    expect(clientQueries).toContainEqual(expect.objectContaining({
      sql: expect.stringContaining("SET status = 'failed'"),
      params: expect.arrayContaining([preRunInsert?.params[0]]),
    }));
  });
});

function sourceRow(id: string, type: "chargebee" | "stripe" | "shopify") {
  return {
    id,
    workspace_id: "ws_1",
    name: id,
    type,
    config: {},
    credentials_ref: null,
  };
}

function connector(type: "stripe" | "shopify", read: ReturnType<typeof vi.fn>) {
  return {
    type,
    streams: () => [{ name: "records", defaultCursorField: "created", read }],
  };
}
