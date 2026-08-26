import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "@axel/shared";

// The connector does a real DNS resolve for its SSRF guard — pin it to a public
// IP so the guard passes without network access.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import { createDatabricksSqlConnector } from "../src/connectors/databricks.ts";

const destination = (): Destination => ({
  destination_id: "dest_dbx_1",
  workspace_id: "ws_1",
  type: "databricks_sql",
  config: {
    workspace_host: "dbc-abc.cloud.databricks.com",
    warehouse_id: "wh_1",
    catalog: "main",
    schema_name: "webhooks",
    access_token: "dapi-token",
  } as unknown as Destination["config"],
  credentials_ref: "cred_1",
});

const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer;

interface FakeRes {
  status: number;
  text: () => Promise<string>;
}
const stmtRes = (
  state: string,
  extra: { message?: string; dataArray?: unknown[][] } = {},
  httpStatus = 200,
): FakeRes => ({
  status: httpStatus,
  text: async () =>
    JSON.stringify({
      statement_id: "stmt_1",
      status: { state, ...(extra.message ? { error: { message: extra.message } } : {}) },
      ...(extra.dataArray ? { result: { data_array: extra.dataArray } } : {}),
    }),
});

type Param = { name: string; value: string; type: string };
const calls: Array<{ statement: string; parameters?: Param[] }> = [];
let responder: (statement: string) => FakeRes;

const fetchMock = vi.fn(async (url: string, init: { method?: string; body?: string }) => {
  if (url.includes("/sql/statements/")) {
    const body = JSON.parse(init.body ?? "{}") as { statement: string; parameters?: Param[] };
    calls.push({ statement: body.statement, ...(body.parameters ? { parameters: body.parameters } : {}) });
    return responder(body.statement);
  }
  throw new Error(`unexpected fetch ${url}`);
});

const deliver = (
  event: ArrayBuffer,
  ctx: Parameters<ReturnType<typeof createDatabricksSqlConnector>["deliver"]>[2],
) => createDatabricksSqlConnector().deliver(event, destination(), ctx);

const inserts = () => calls.filter((c) => c.statement.startsWith("INSERT"));

describe("databricks_sql connector", () => {
  beforeEach(() => {
    calls.length = 0;
    responder = () => stmtRes("SUCCEEDED");
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("json_column (default) inserts the JSON body as one STRING parameter", async () => {
    const out = await deliver(encode({ a: 1 }), { eventId: "e1", binding: { table: "events" } });
    expect(out.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.statement).toBe("INSERT INTO `main`.`webhooks`.`events` (`payload`) VALUES (:p)");
    expect(calls[0]!.parameters).toEqual([{ name: "p", value: JSON.stringify({ a: 1 }), type: "STRING" }]);
  });

  it("typed_columns sends native typed parameters and flattens nested objects", async () => {
    const out = await deliver(
      encode({ id: 42, active: true, ratio: 0.5, name: "x", data: { lead_score: 9 } }),
      { eventId: "e2", binding: { table: "subs", mode: "typed_columns" } },
    );
    expect(out.status).toBe("success");
    expect(calls[0]!.statement).toContain("INSERT INTO `main`.`webhooks`.`subs`");
    expect(calls[0]!.statement).toContain("`data_lead_score`"); // nested flattened
    const byValue = calls[0]!.parameters!.map((p) => ({ value: p.value, type: p.type }));
    expect(byValue).toContainEqual({ value: "42", type: "BIGINT" });
    expect(byValue).toContainEqual({ value: "true", type: "BOOLEAN" });
    expect(byValue).toContainEqual({ value: "0.5", type: "DOUBLE" });
    expect(byValue).toContainEqual({ value: "x", type: "STRING" });
    expect(byValue).toContainEqual({ value: "9", type: "BIGINT" });
  });

  it("typed_columns creates the Delta table on first delivery (table missing)", async () => {
    responder = (stmt) => {
      if (stmt.startsWith("INSERT")) {
        return inserts().length === 1
          ? stmtRes("FAILED", { message: "[TABLE_OR_VIEW_NOT_FOUND] Table or view not found: main.webhooks.subs" })
          : stmtRes("SUCCEEDED");
      }
      if (stmt.startsWith("DESCRIBE")) {
        return stmtRes("FAILED", { message: "[TABLE_OR_VIEW_NOT_FOUND] Table or view not found" });
      }
      return stmtRes("SUCCEEDED"); // CREATE
    };
    const out = await deliver(encode({ id: 42, active: true }), {
      eventId: "e3",
      binding: { table: "subs", mode: "typed_columns" },
    });
    expect(out.status).toBe("success");
    const create = calls.find((c) => c.statement.startsWith("CREATE TABLE"));
    expect(create).toBeDefined();
    expect(create!.statement).toContain("`id` BIGINT");
    expect(create!.statement).toContain("`active` BOOLEAN");
    expect(create!.statement).toContain("USING DELTA");
    expect(inserts()).toHaveLength(2); // failed, then retried after create
  });

  it("typed_columns adds only the missing columns via ALTER (column drift)", async () => {
    responder = (stmt) => {
      if (stmt.startsWith("INSERT")) {
        return inserts().length === 1
          ? stmtRes("FAILED", { message: "[UNRESOLVED_COLUMN] A column with name `newcol` cannot be resolved" })
          : stmtRes("SUCCEEDED");
      }
      if (stmt.startsWith("DESCRIBE")) {
        return stmtRes("SUCCEEDED", {
          dataArray: [
            ["id", "bigint", null],
            ["active", "boolean", null],
          ],
        });
      }
      return stmtRes("SUCCEEDED"); // ALTER
    };
    const out = await deliver(encode({ id: 42, active: true, newcol: "hi" }), {
      eventId: "e4",
      binding: { table: "subs", mode: "typed_columns" },
    });
    expect(out.status).toBe("success");
    const alter = calls.find((c) => c.statement.startsWith("ALTER TABLE"));
    expect(alter).toBeDefined();
    expect(alter!.statement).toContain("ADD COLUMNS");
    expect(alter!.statement).toContain("`newcol` STRING");
    expect(alter!.statement).not.toContain("`id`"); // existing column not re-added
  });

  it("typed_columns dead-letters a genuine type conflict without attempting DDL", async () => {
    responder = (stmt) =>
      stmt.startsWith("INSERT")
        ? stmtRes("FAILED", { message: "[DELTA_FAILED_TO_MERGE_FIELDS] Failed to cast value to BIGINT for column `id`" })
        : stmtRes("SUCCEEDED");
    const out = await deliver(encode({ id: "not-a-number" }), {
      eventId: "e5",
      binding: { table: "subs", mode: "typed_columns" },
    });
    expect(out.status).toBe("dead");
    expect(
      calls.find(
        (c) =>
          c.statement.startsWith("CREATE") ||
          c.statement.startsWith("ALTER") ||
          c.statement.startsWith("DESCRIBE"),
      ),
    ).toBeUndefined();
  });
});
