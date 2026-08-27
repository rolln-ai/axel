import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import type { Queryable } from "../lib/db";

vi.mock("../lib/db", () => ({
  db: () => ({
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  }),
  withTransaction: async (fn: (client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number }> }) => Promise<void>) => {
    await fn({
      query: vi.fn(async () => ({ rowCount: 0 })),
    });
  },
}));

describe("data reset", () => {
  afterEach(() => {
    delete process.env.CLICKHOUSE_URL;
    vi.restoreAllMocks();
  });

  it("deletes through the configured bucket with literal R2 key slashes", async () => {
    const { deleteR2Objects } = await import("../lib/data-reset");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));

    await expect(deleteR2Objects(["events/ws one/evt.json"], {
      fetchImpl,
      env: {
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_API_TOKEN: "token",
        RAW_PAYLOAD_BUCKET: "selfhost-raw",
      },
    })).resolves.toEqual({ deleted: 1, skipped: false });

    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/selfhost-raw/objects/events/ws%20one/evt.json",
    );
  });

  it("refuses the hosted bucket default in self-hosted mode", async () => {
    const { deleteR2Objects } = await import("../lib/data-reset");

    await expect(deleteR2Objects(["events/one.json"], {
      env: {
        AXEL_DEPLOYMENT_MODE: "self-hosted",
        CLOUDFLARE_ACCOUNT_ID: "acct",
        CLOUDFLARE_API_TOKEN: "token",
      },
    })).rejects.toThrow(/RAW_PAYLOAD_BUCKET is required/);
  });

  it("deletes raw payloads through bounded native R2 batches before wiping databases", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const calls: string[] = [];
    const client: ClickhouseQueryable = {
      async query<_T = Record<string, unknown>>(sql: string) {
        calls.push(sql);
        return { rows: [] };
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ workspace_id: "ws_test", deleted: 1_000, complete: false }))
      .mockResolvedValueOnce(Response.json({ workspace_id: "ws_test", deleted: 2, complete: true }));

    const result = await wipeWorkspaceData("ws_test", {
      includeRawPayloads: true,
      deps: {
        clickhouse: client,
        fetchImpl,
        env: {
          INGEST_ADMIN_URL: "https://ingest.example",
          INGEST_ADMIN_TOKEN: "token",
        },
      },
    });

    expect(result.r2Deleted).toBe(1_002);
    expect(result.r2LimitReached).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://ingest.example/admin/workspace-payloads/delete-batch",
    );
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe("manual");
    expect(calls.some((sql) => sql.includes("SELECT DISTINCT r2_key"))).toBe(false);
  });

  it("returns a resumable R2 stage without starting Postgres or ClickHouse cleanup", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const clickhouse = { query: vi.fn(async () => ({ rows: [] })) } as unknown as ClickhouseQueryable;
    const pg = { query: vi.fn(async (_sql?: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })) };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ workspace_id: "ws_large", deleted: 1_000, complete: false }));

    const result = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: true,
      deps: {
        clickhouse,
        pg,
        fetchImpl,
        r2MaxBatches: 2,
        r2PaceMs: 0,
        env: {
          INGEST_ADMIN_URL: "https://ingest.example/admin/source-cache/put",
          INGEST_ADMIN_TOKEN: "token",
        },
      },
    });

    expect(result).toMatchObject({
      r2Deleted: 2_000,
      r2LimitReached: true,
      postgresRows: 0,
      postgresLimitReached: false,
      clickhouseLimitReached: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // Only the r2-prefix enumeration read runs during the R2 stage — no
    // Postgres row-deletes start until the payloads are gone.
    expect(pg.query.mock.calls.every(([sql]) => !/DELETE/i.test(String(sql)))).toBe(true);
    expect(clickhouse.query).not.toHaveBeenCalled();
  });

  it("passes custom r2-destination mirror prefixes to the teardown endpoint", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const clickhouse = { query: vi.fn(async () => ({ rows: [] })) } as unknown as ClickhouseQueryable;
    // Two r2 destinations: one custom "exports" prefix, one on the default.
    const pg = {
      query: vi.fn(async (_sql?: string, _params?: unknown[]) => ({
        rows: [{ prefix: "exports" }, { prefix: "deliveries" }] as Array<Record<string, unknown>>,
        rowCount: 2,
      })),
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ workspace_id: "ws_cust", deleted: 0, complete: true }),
    );

    await wipeWorkspaceData("ws_cust", {
      includeRawPayloads: true,
      deps: {
        clickhouse,
        pg: pg as unknown as Queryable,
        fetchImpl,
        env: { INGEST_ADMIN_URL: "https://ingest.example", INGEST_ADMIN_TOKEN: "token" },
      },
    });

    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    // Custom "exports" prefix is forwarded (workspace-scoped); the "deliveries"
    // default is dropped (the endpoint already sweeps it).
    expect(body.extra_prefixes).toEqual(["exports/ws_cust/"]);
  });

  it("turns a slow later R2 batch into resumable progress instead of a failed cron", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const clickhouse = { query: vi.fn(async () => ({ rows: [] })) } as unknown as ClickhouseQueryable;
    const pg = { query: vi.fn(async (_sql?: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })) };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({ workspace_id: "ws_large", deleted: 1_000, complete: false }),
      )
      .mockRejectedValueOnce(new DOMException("This operation was aborted", "AbortError"));

    const result = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: true,
      deps: {
        clickhouse,
        pg,
        fetchImpl,
        r2MaxBatches: 2,
        r2PaceMs: 0,
        env: {
          INGEST_ADMIN_URL: "https://ingest.example",
          INGEST_ADMIN_TOKEN: "token",
        },
      },
    });

    expect(result).toMatchObject({ r2Deleted: 1_000, r2LimitReached: true });
    // Only the r2-prefix enumeration read runs during the R2 stage — no
    // Postgres row-deletes start until the payloads are gone.
    expect(pg.query.mock.calls.every(([sql]) => !/DELETE/i.test(String(sql)))).toBe(true);
    expect(clickhouse.query).not.toHaveBeenCalled();
  });

  it("treats first-batch R2 backpressure as a resumable no-progress pass", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const clickhouse = { query: vi.fn(async () => ({ rows: [] })) } as unknown as ClickhouseQueryable;
    const pg = { query: vi.fn(async (_sql?: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })) };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new DOMException("This operation was aborted", "AbortError"));

    const result = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: true,
      deps: {
        clickhouse,
        pg,
        fetchImpl,
        env: {
          INGEST_ADMIN_URL: "https://ingest.example",
          INGEST_ADMIN_TOKEN: "token",
        },
      },
    });

    expect(result).toMatchObject({ r2Deleted: 0, r2LimitReached: true });
    // Only the r2-prefix enumeration read runs during the R2 stage — no
    // Postgres row-deletes start until the payloads are gone.
    expect(pg.query.mock.calls.every(([sql]) => !/DELETE/i.test(String(sql)))).toBe(true);
    expect(clickhouse.query).not.toHaveBeenCalled();
  });

  it("refuses an unbounded legacy REST purge when the native R2 admin path is missing", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const keys = Array.from({ length: 10_000 }, (_, index) => ({
      r2_key: `events/ws_large/${String(index).padStart(5, "0")}`,
    }));
    const clickhouse: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(sql: string) {
        return { rows: (sql.includes("SELECT DISTINCT r2_key") ? keys : []) as T[] };
      },
    };
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(wipeWorkspaceData("ws_large", {
      includeRawPayloads: true,
      deps: {
        clickhouse,
        fetchImpl,
        env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_API_TOKEN: "token" },
      },
    })).rejects.toThrow("r2_bulk_purge_required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries transient R2 delete failures", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const client: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(sql: string) {
        if (sql.includes("SELECT DISTINCT r2_key")) {
          return { rows: [{ r2_key: "events/ws_test/one.json" }] as T[] };
        }
        return { rows: [] };
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        errors: [{ code: 10001, message: "We encountered an internal error. Please try again." }],
      }), { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await wipeWorkspaceData("ws_test", {
      includeRawPayloads: true,
      deps: {
        clickhouse: client,
        fetchImpl,
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_API_TOKEN: "token",
        },
      },
    });

    expect(result.r2Deleted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("backs off and retries Cloudflare R2 throttling responses", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const sleep = vi.spyOn(globalThis, "setTimeout");
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const client: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(sql: string) {
        if (sql.includes("SELECT DISTINCT r2_key")) {
          return { rows: [{ r2_key: "events/ws_test/throttled.json" }] as T[] };
        }
        return { rows: [] };
      },
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: false,
        errors: [{ code: 971, message: "Please wait and consider throttling your request speed" }],
        messages: [],
        result: null,
      }), { status: 429 }))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await wipeWorkspaceData("ws_test", {
      includeRawPayloads: true,
      deps: {
        clickhouse: client,
        fetchImpl,
        env: {
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_API_TOKEN: "token",
        },
      },
    });

    expect(result.r2Deleted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(expect.any(Function), 1000);
  });

  it("commits operational deletes in bounded Postgres batches", async () => {
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const pg = {
      query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 10_000 })),
    };

    const result = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: false,
      deps: { pg },
    });

    expect(result).toMatchObject({
      postgresRows: 100_000,
      postgresLimitReached: true,
      clickhouseTables: [],
      clickhouseLimitReached: false,
    });
    expect(pg.query).toHaveBeenCalledTimes(10);
    expect(String(pg.query.mock.calls[0]?.[0])).toContain("WHERE ctid IN");
    expect(pg.query.mock.calls[0]?.[1]).toEqual(["ws_large", 10_000]);
  });

  it("includes Data Contract fixtures and drift in an event-data wipe", async () => {
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const sql: string[] = [];
    const pg: Queryable = {
      async query(statement) {
        sql.push(statement);
        return { rows: [], rowCount: 0 };
      },
    };

    const result = await wipeWorkspaceData("ws_private", {
      includeRawPayloads: false,
      deps: { pg },
    });

    expect(result.postgresLimitReached).toBe(false);
    expect(sql.some((statement) => statement.includes("FROM data_contract_fixtures"))).toBe(true);
    expect(sql.some((statement) => statement.includes("FROM data_contract_drift_events"))).toBe(true);
    expect(sql.every((statement) => statement.includes("workspace_id = $1"))).toBe(true);
  });

  it("starts ClickHouse mutations asynchronously and waits for completion on later ticks", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    const { wipeWorkspaceData } = await import("../lib/data-reset");
    const pg = { query: vi.fn(async (_sql?: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })) };
    let mutationPending = false;
    let rowsRemain = true;
    const clickhouse: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(sql: string) {
        if (sql.includes("FROM system.mutations")) {
          return {
            rows: (mutationPending
              ? [{ table_name: "events", latest_fail_reason: "" }]
              : []) as T[],
          };
        }
        if (sql.includes("count() AS row_count")) {
          return {
            rows: (rowsRemain
              ? [
                  { table_name: "events", row_count: "1463306" },
                  { table_name: "events_daily", row_count: "42" },
                ]
              : [
                  { table_name: "delivery_attempts", row_count: "0" },
                  { table_name: "route_evaluations", row_count: "0" },
                  { table_name: "events", row_count: "0" },
                  { table_name: "events_daily", row_count: "0" },
                  { table_name: "delivery_latest_outcomes", row_count: "0" },
                  { table_name: "delivery_base_latest_outcomes", row_count: "0" },
                ]) as T[],
          };
        }
        if (sql.includes("ALTER TABLE events")) mutationPending = true;
        return { rows: [] };
      },
    };

    const started = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: false,
      deps: { pg, clickhouse },
    });
    expect(started).toMatchObject({
      clickhouseTables: ["events", "events_daily"],
      clickhouseLimitReached: true,
    });

    const waiting = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: false,
      deps: { pg, clickhouse },
    });
    expect(waiting).toMatchObject({
      clickhouseTables: ["events"],
      clickhouseLimitReached: true,
    });

    mutationPending = false;
    rowsRemain = false;
    const complete = await wipeWorkspaceData("ws_large", {
      includeRawPayloads: false,
      deps: { pg, clickhouse },
    });
    expect(complete).toMatchObject({
      clickhouseTables: [],
      clickhouseLimitReached: false,
    });
  });
});
