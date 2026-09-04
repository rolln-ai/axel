import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HttpIngestPullRecordSink,
  PullBatchError,
  runActivePullSources,
} from "../src/index";

describe("pull worker scheduling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
        { kind: "pre_run", error: "operation_failed" },
        { kind: "stream", error: "operation_failed" },
      ],
    });
    expect(JSON.stringify(aggregate)).not.toContain("src_pre");
    expect(JSON.stringify(aggregate)).not.toContain("src_failed");
    expect(JSON.stringify(aggregate)).not.toContain("ws_1");
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

  it("binds a credential lookup to the parent workspace and pull source", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "00".repeat(32));
    const row = {
      ...sourceRow("src_bound", "stripe"),
      credentials_ref: "cred_other",
    };
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const lockClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        clientQueries.push({ sql, params });
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(runActivePullSources({
      pool: { query, connect: async () => lockClient } as never,
    })).rejects.toBeInstanceOf(PullBatchError);

    const credentialCall = clientQueries.find((call) =>
      call.sql.includes("FROM pull_source_credentials")
    );
    expect(credentialCall?.sql).toContain("AND workspace_id = $2");
    expect(credentialCall?.sql).toContain("AND pull_source_id = $3");
    expect(credentialCall?.params).toEqual(["cred_other", "ws_1", "src_bound"]);
  });

  it("sanitizes stream diagnostics and persisted run summaries", async () => {
    const row = sourceRow("src_private", "stripe");
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
    const clientQueries: Array<{ sql: string; params: unknown[] }> = [];
    const lockClient = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        clientQueries.push({ sql, params });
        if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const attackerDetail =
      'HTTP 500: source=src_private workspace=ws_private stream=customers customer=cus_private payload={"email":"victim@example.com","api_key":"sk_live_response_secret"}';
    const connectors = new Map([
      ["stripe", connector("stripe", vi.fn(async () => {
        throw new Error(attackerDetail);
      }))],
    ]);

    let aggregate: PullBatchError | undefined;
    try {
      await runActivePullSources({
        pool: { query, connect: async () => lockClient } as never,
        connectors: connectors as never,
        recordSink: { write: vi.fn(async () => undefined) },
      });
    } catch (error) {
      aggregate = error as PullBatchError;
    }

    expect(aggregate?.failures[0]?.error).toBe("http_error_500");
    const terminalUpdate = clientQueries.find((call) =>
      call.sql.includes("SET status = $2")
    );
    expect(terminalUpdate?.params[4]).toBe("http_error_500");
    const allDiagnostics = JSON.stringify({
      errorMessage: terminalUpdate?.params[4],
      failures: aggregate?.failures,
      logs: consoleError.mock.calls,
    });
    expect(allDiagnostics).not.toContain("src_private");
    expect(allDiagnostics).not.toContain("ws_private");
    expect(allDiagnostics).not.toContain("customers");
    expect(allDiagnostics).not.toContain("cus_private");
    expect(allDiagnostics).not.toContain("victim@example.com");
    expect(allDiagnostics).not.toContain("sk_live_response_secret");
  });

  it("does not read or follow an ingest rejection body with the source token attached", async () => {
    const cancel = vi.fn(async () => undefined);
    const readBody = vi.fn(async () => "payload=must-not-be-read");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return {
        ok: false,
        status: 302,
        body: { cancel },
        text: readBody,
      } as unknown as Response;
    });
    const sink = new HttpIngestPullRecordSink({
      ingestBaseUrl: "https://ingest.example.test",
      token: "source-secret-token",
      fetchImpl,
    });

    await expect(sink.write({
      source_id: "src_1",
      workspace_id: "ws_1",
      source_type: "stripe",
      stream: "customers",
      record_id: "cus_1",
      cursor: { value: 1 },
      extracted_at: "2026-08-26T00:00:00.000Z",
      data: { id: "cus_1" },
    })).rejects.toThrow("HTTP 302");

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      "x-axel-token": "source-secret-token",
    });
    expect(readBody).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
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
