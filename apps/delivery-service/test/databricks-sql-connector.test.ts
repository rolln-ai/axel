import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Destination } from "@axel/shared";

// The connector does a real DNS resolve for its SSRF guard — pin it to a public
// IP so the guard passes without network access.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

import {
  createDatabricksSqlConnector,
  type DatabricksFetch,
} from "../src/connectors/databricks.ts";

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
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
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
) => createDatabricksSqlConnector(fetchMock as DatabricksFetch).deliver(event, destination(), ctx);

const inserts = () => calls.filter((c) => c.statement.startsWith("INSERT"));

describe("databricks_sql connector", () => {
  beforeEach(() => {
    calls.length = 0;
    responder = () => stmtRes("SUCCEEDED");
    fetchMock.mockClear();
  });

  it("json_column (default) inserts the JSON body as one STRING parameter", async () => {
    const out = await deliver(encode({ a: 1 }), { eventId: "e1", binding: { table: "events" } });
    expect(out.status).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.statement).toBe("INSERT INTO `main`.`webhooks`.`events` (`payload`) VALUES (:p)");
    expect(calls[0]!.parameters).toEqual([{ name: "p", value: JSON.stringify({ a: 1 }), type: "STRING" }]);
  });

  it("caps successful response bodies before buffering them", async () => {
    const text = vi.fn(async () => {
      throw new Error("streaming response must not fall back to text()");
    });
    responder = () => ({
      status: 200,
      text,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(600_000));
          controller.enqueue(new Uint8Array(600_000));
          controller.close();
        },
      }),
    });

    const out = await deliver(encode({ a: 1 }), {
      eventId: "e-response-cap",
      binding: { table: "events" },
    });

    expect(out.status).toBe("dead");
    expect(out.response).toEqual({ error: "databricks_response_too_large" });
    expect(text).not.toHaveBeenCalled();
  });

  it("does not retain non-success response bodies that can echo event data", async () => {
    const text = vi.fn(async () => "customer payload echoed here");
    responder = () => ({ status: 400, text });

    const out = await deliver(encode({ secret: "customer payload" }), {
      eventId: "e-response-privacy",
      binding: { table: "events" },
    });

    expect(out.status).toBe("dead");
    expect(out.response).toEqual({ status: 400 });
    expect(text).not.toHaveBeenCalled();
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
    // Managed DDL widens integral numbers to DOUBLE (integer-first drift, same
    // hazard #367 fixed for BigQuery) — the row parameter stays exact BIGINT.
    expect(create!.statement).toContain("`id` DOUBLE");
    expect(create!.statement).toContain("`active` BOOLEAN");
    expect(create!.statement).toContain("USING DELTA");
    expect(inserts()).toHaveLength(2); // failed, then retried after create
    const insertParams = inserts()[1].parameters ?? [];
    expect(insertParams).toContainEqual(expect.objectContaining({ value: "42", type: "BIGINT" }));
  });

  it("typed_columns creates integral-number columns as DOUBLE so later fractional values insert", async () => {
    responder = (stmt) => {
      if (stmt.startsWith("INSERT")) {
        return inserts().length === 1
          ? stmtRes("FAILED", { message: "[TABLE_OR_VIEW_NOT_FOUND] Table or view not found: main.webhooks.metrics" })
          : stmtRes("SUCCEEDED");
      }
      if (stmt.startsWith("DESCRIBE")) {
        return stmtRes("FAILED", { message: "[TABLE_OR_VIEW_NOT_FOUND] Table or view not found" });
      }
      return stmtRes("SUCCEEDED"); // CREATE
    };
    // First event carries an integral amount; the column must not be BIGINT.
    const out = await deliver(encode({ amount: 100 }), {
      eventId: "e3b",
      binding: { table: "metrics", mode: "typed_columns" },
    });
    expect(out.status).toBe("success");
    const create = calls.find((c) => c.statement.startsWith("CREATE TABLE"));
    expect(create!.statement).toContain("`amount` DOUBLE");
    expect(create!.statement).not.toContain("BIGINT");
  });

  it("leaves existing Delta schemas unchanged unless additions are explicitly enabled", async () => {
    responder = (stmt) => stmt.startsWith("INSERT")
      ? stmtRes("FAILED", { message: "[UNRESOLVED_COLUMN] newcol cannot be resolved" })
      : stmtRes("SUCCEEDED", { dataArray: [["existing", "string", null]] });
    const out = await deliver(encode({ newcol: "value" }), {
      binding: { table: "subs", mode: "typed_columns" },
    });
    expect(out.status).toBe("dead");
    expect(out.response).toMatchObject({ code: "databricks_schema_change_required" });
    expect(calls.some(c => c.statement.startsWith("ALTER"))).toBe(false);
    expect(inserts()).toHaveLength(1);
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
    const out = await deliver(encode({ id: 42, active: true, newcol: "hi", count: 7 }), {
      eventId: "e4",
      binding: { table: "subs", mode: "typed_columns", schema_evolution: "add_columns" },
    });
    expect(out.status).toBe("success");
    const alter = calls.find((c) => c.statement.startsWith("ALTER TABLE"));
    expect(alter).toBeDefined();
    expect(alter!.statement).toContain("ADD COLUMNS");
    expect(alter!.statement).toContain("`newcol` STRING");
    expect(alter!.statement).toContain("`count` DOUBLE"); // added integral column widened
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
