import { describe, expect, it } from "vitest";
import { createBigQueryConnector, type BigQueryClientLike } from "../src/bigquery";

// Audit fix: the INFORMATION_SCHEMA region qualifier must be `region-<loc>`.
// A configured location like "US" / "us-central1" previously produced a bare
// `us` / `us-central1`, which BigQuery rejects — so discovery failed for every
// workspace that set a location.
describe("bigquery connector — discovery region qualifier", () => {
  function stubConnector(sqls: string[]) {
    const client: BigQueryClientLike = {
      async query(input) {
        sqls.push(input.sql);
        return { rows: [] };
      },
    };
    return createBigQueryConnector({ connect: async () => client });
  }

  it("prefixes a configured location with region-", async () => {
    const sqls: string[] = [];
    const connector = stubConnector(sqls);
    await connector.listSchemaObjects?.({ project_id: "p", service_account_json: "{}", location: "US" });
    expect(sqls.some((s) => s.includes("`region-us`"))).toBe(true);
    expect(sqls.some((s) => /`us`\.INFORMATION_SCHEMA/.test(s))).toBe(false);
  });

  it("defaults to region-us when no location is set", async () => {
    const sqls: string[] = [];
    const connector = stubConnector(sqls);
    await connector.listSchemaObjects?.({ project_id: "p", service_account_json: "{}" });
    expect(sqls.some((s) => s.includes("`region-us`"))).toBe(true);
  });

  it("does not double-prefix an already region-qualified location", async () => {
    const sqls: string[] = [];
    const connector = stubConnector(sqls);
    await connector.listSchemaObjects?.({ project_id: "p", service_account_json: "{}", location: "region-eu" });
    expect(sqls.some((s) => s.includes("`region-eu`"))).toBe(true);
    expect(sqls.some((s) => s.includes("region-region-"))).toBe(false);
  });
});

describe("bigquery connector — dataset identifier (hyphen allowed, backtick rejected)", () => {
  function streamRead(datasetName: string): Promise<unknown> {
    const config = {
      project_id: "p",
      service_account_json: "{}",
      streams: [{ name: "s", dataset: datasetName, table: "events", cursor_column: "updated_at" }],
    };
    const client: BigQueryClientLike = { async query() { return { rows: [] }; } };
    const connector = createBigQueryConnector({ connect: async () => client });
    const stream = connector.streams(config as never)[0]!;
    return stream.read({
      source: { source_id: "s1", workspace_id: "w1", type: "bigquery", name: "n", config },
      stream: config.streams[0],
      state: null,
      now: () => new Date(),
    } as never);
  }

  it("accepts a hyphenated (project-qualified) dataset — previously rejected", async () => {
    await expect(streamRead("my-project")).resolves.toBeDefined();
  });

  it("still rejects a backtick in the identifier (no quote break-out)", async () => {
    await expect(streamRead("evil`drop")).rejects.toThrow(/invalid_identifier|must match/);
  });
});

describe("bigquery connector — custom-SQL null cursor (first run returns rows, not zero)", () => {
  function customSqlRead(args: {
    state: { cursor: { value: string | number } | null } | null;
    cursorType?: "timestamp" | "integer" | "string";
  }) {
    const params: Array<Record<string, unknown>> = [];
    const client: BigQueryClientLike = {
      async query(input) {
        params.push(input.params);
        return { rows: [] };
      },
    };
    const config = {
      project_id: "p",
      service_account_json: "{}",
      streams: [
        {
          name: "s",
          sql: "SELECT * FROM t WHERE updated_at > @cursor",
          cursor_column: "updated_at",
          ...(args.cursorType ? { cursor_type: args.cursorType } : {}),
        },
      ],
    };
    const connector = createBigQueryConnector({ connect: async () => client });
    const stream = connector.streams(config as never)[0]!;
    return stream
      .read({
        source: { source_id: "s1", workspace_id: "w1", type: "bigquery", name: "n", config },
        stream: config.streams[0],
        state: args.state,
        now: () => new Date(),
      } as never)
      .then(() => params);
  }

  it("substitutes a non-null timestamp sentinel on the first run (null cursor)", async () => {
    // Previously @cursor was null → `updated_at > NULL` matched nothing → the
    // custom stream returned zero rows forever. The sentinel makes it match all.
    const params = await customSqlRead({ state: null });
    expect(params[0]?.cursor).not.toBeNull();
    expect(typeof params[0]?.cursor).toBe("string");
    // Must be below any plausible real timestamp so `col > @cursor` admits all rows.
    expect(String(params[0]?.cursor) < "2000-01-01T00:00:00.000Z").toBe(true);
  });

  it("uses an integer sentinel for an integer cursor on the first run", async () => {
    const params = await customSqlRead({ state: null, cursorType: "integer" });
    expect(typeof params[0]?.cursor).toBe("number");
    expect(params[0]?.cursor as number).toBeLessThan(0);
  });

  it("uses the real watermark (not the sentinel) once a cursor is persisted", async () => {
    const params = await customSqlRead({ state: { cursor: { value: "2026-06-01T00:00:00Z" } } });
    expect(params[0]?.cursor).toBe("2026-06-01T00:00:00Z");
  });
});
