import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  planColumnRepair,
  planDottedColumnInsert,
  type Destination,
  type PgLeafType,
} from "@axel/shared";

// Mock pg.Pool before the connector imports it.
const queryMock = vi.hoisted(() => vi.fn());
const endMock = vi.hoisted(() => vi.fn());
const onMock = vi.hoisted(() => vi.fn());

vi.mock("pg", () => ({
  default: {
    Pool: class FakePool {
      options: { connectionString: string };
      constructor(options: { connectionString: string }) {
        this.options = options;
      }
      query = queryMock;
      on = onMock;
      end = endMock;
    },
  },
}));

import { createPostgresConnector, closeAllPostgresPools } from "../src/connectors/postgres.ts";

const destination = (): Destination => ({
  destination_id: "dest_pg_1",
  workspace_id: "ws_1",
  type: "postgres",
  config: {
    connection_string: "postgres://test:test@db.example.test/test",
    // No table here — connector resolves from binding.
  } as unknown as Destination["config"],
  credentials_ref: "cred_1",
});

const encode = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj)).buffer;

describe("postgres connector — route binding", () => {
  beforeEach(() => {
    queryMock.mockReset();
    onMock.mockReset();
    endMock.mockReset();
  });

  afterEach(async () => {
    await closeAllPostgresPools();
  });

  it("uses binding.table over destination.config.table", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const connector = createPostgresConnector();

    const out = await connector.deliver(encode({ a: 1 }), destination(), {
      eventId: "evt-1",
      binding: { table: "route_specific_table", mode: "jsonb_blob", payload_column: "p" },
    });

    expect(out.status).toBe("success");
    // The INSERT should target the binding's table, not anything from config.
    const sql = String(queryMock.mock.calls[0]?.[0]);
    // Bare table → "public"."table" (two-part quote so a schema-qualified target
    // like "app.events" would route to "app"."events", not a literal public table).
    expect(sql).toContain('INSERT INTO "public"."route_specific_table"');
    expect(sql).toContain('("p")');
  });

  it("falls back to destination.config.table when binding is missing (legacy)", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const connector = createPostgresConnector();
    const dest = destination();
    (dest.config as Record<string, unknown>).table = "legacy_table";
    (dest.config as Record<string, unknown>).payload_column = "data";

    const out = await connector.deliver(encode({ a: 1 }), dest, { eventId: "evt-1" });

    expect(out.status).toBe("success");
    const sql = String(queryMock.mock.calls[0]?.[0]);
    expect(sql).toContain('INSERT INTO "public"."legacy_table"');
    expect(sql).toContain('("data")');
  });

  it("dead-letters when neither binding nor config provides a table", async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    const connector = createPostgresConnector();

    const out = await connector.deliver(encode({ a: 1 }), destination(), { eventId: "evt-1" });

    expect(out.status).toBe("dead");
    expect((out.response as { error: string }).error).toMatch(/no table binding/);
  });
});

describe("postgres connector — dotted_columns mode", () => {
  beforeEach(() => {
    queryMock.mockReset();
    onMock.mockReset();
    endMock.mockReset();
  });

  afterEach(async () => {
    await closeAllPostgresPools();
  });

  it("creates table, adds columns for new leaf keys, then INSERTs with quoted dot names", async () => {
    // First call: CREATE TABLE IF NOT EXISTS
    // Second call: SELECT information_schema (returns no columns initially)
    // Third call: ALTER TABLE ADD COLUMN
    // Fourth call: INSERT
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ column_name: "id" }, { column_name: "received_at" }], rowCount: 2 }) // schema read
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER TABLE
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT

    const connector = createPostgresConnector();
    const out = await connector.deliver(
      encode({
        user: { email: "a@b.test", age: 30 },
        kind: "signup",
        active: true,
      }),
      destination(),
      {
        eventId: "evt-dotted-1",
        binding: { table: "events_flat", mode: "dotted_columns" },
      },
    );

    expect(out.status).toBe("success");

    // CREATE TABLE was issued (bare table → public schema, two-part quoted).
    expect(String(queryMock.mock.calls[0]?.[0])).toContain('CREATE TABLE IF NOT EXISTS "public"."events_flat"');

    // ALTER TABLE added all leaf keys with type-inferred types.
    const alterSql = String(queryMock.mock.calls[2]?.[0]);
    expect(alterSql).toContain('ALTER TABLE "public"."events_flat"');
    expect(alterSql).toContain('ADD COLUMN IF NOT EXISTS "user.email" text');
    expect(alterSql).toContain('ADD COLUMN IF NOT EXISTS "user.age" bigint');
    expect(alterSql).toContain('ADD COLUMN IF NOT EXISTS "kind" text');
    expect(alterSql).toContain('ADD COLUMN IF NOT EXISTS "active" boolean');

    // INSERT used quoted dot-notation column names (table two-part quoted).
    const insertSql = String(queryMock.mock.calls[3]?.[0]);
    expect(insertSql).toContain('INSERT INTO "public"."events_flat"');
    expect(insertSql).toContain('"user.email"');
    expect(insertSql).toContain('"user.age"');
    expect(insertSql).toContain('"kind"');
    expect(insertSql).toContain('"active"');
  });

  it("wraps a non-object payload into a `value` column instead of dead-lettering (dotted_columns)", async () => {
    // Post-audit: a scalar/array payload used to dead-letter here. The shared
    // flattenPayloadToColumns now wraps it as { value: … } so valid-but-unusual
    // events land rather than being lost.
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    const connector = createPostgresConnector();
    const out = await connector.deliver(
      encode("just a string"),
      destination(),
      { eventId: "evt-1", binding: { table: "t", mode: "dotted_columns" } },
    );
    expect(out.status).toBe("success");
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("INSERT INTO") && s.includes('"value"'))).toBe(true);
  });

  it("remaps a top-level reserved `id` field so it can't clobber the bigserial PK", async () => {
    // Audit fix: an event carrying a top-level `id` (e.g. a Stripe object) used
    // to collide with the shell PK and dead-letter. flattenPayloadToColumns
    // remaps it to `id__field` so the event lands.
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
      .mockResolvedValueOnce({
        rows: [
          { column_name: "id", data_type: "bigint" },
          { column_name: "received_at", data_type: "timestamp with time zone" },
        ],
        rowCount: 2,
      }) // schema read
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER ADD
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    const connector = createPostgresConnector();
    const out = await connector.deliver(
      encode({ id: "evt_abc", kind: "signup" }),
      destination(),
      { eventId: "evt-1", binding: { table: "t", mode: "dotted_columns" } },
    );
    expect(out.status).toBe("success");
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes('"id__field"'))).toBe(true);
  });

  it("widens an existing column when a later event's value type conflicts", async () => {
    // Audit fix: a cross-event type conflict (stored bigint, incoming text) used
    // to throw 22P02 and dead-letter. widenPgType now ALTERs the column to the
    // wider type so both events land.
    queryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // CREATE TABLE
      .mockResolvedValueOnce({ rows: [{ column_name: "score", data_type: "bigint" }], rowCount: 1 }) // schema read
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // ALTER ... TYPE text
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT
    const connector = createPostgresConnector();
    const out = await connector.deliver(
      encode({ score: "high" }),
      destination(),
      { eventId: "evt-1", binding: { table: "t", mode: "dotted_columns" } },
    );
    expect(out.status).toBe("success");
    const sqls = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /ALTER COLUMN "score" TYPE text/.test(s))).toBe(true);
  });
});

/**
 * Shared dotted-columns planner (@axel/shared planDottedColumnInsert) — the
 * pure add/widen/ALTER/INSERT planning both drivers execute. Each case runs
 * in BOTH param encodings: "stringified" (node-pg, this service) and "raw"
 * (postgres.js, delivery-edge), pinning that the SQL is identical and only
 * the jsonb param encoding differs.
 */
describe.each([
  { jsonbParams: "stringified" as const, driver: "node-pg (delivery-service)" },
  { jsonbParams: "raw" as const, driver: "postgres.js (delivery-edge)" },
])("shared dotted-columns planner — $driver", ({ jsonbParams }) => {
  const types = (entries: Record<string, PgLeafType>) => new Map(Object.entries(entries));

  it("plans ADDs for new leaf keys and an INSERT over quoted dot names", () => {
    const plan = planDottedColumnInsert(
      "events_flat",
      { user: { email: "a@b.test", age: 30 }, kind: "signup", active: true },
      types({}),
      { jsonbParams },
    );
    expect(plan).not.toBeNull();
    expect(plan!.addColumnsSql).toContain('ALTER TABLE "public"."events_flat"');
    expect(plan!.addColumnsSql).toContain('ADD COLUMN IF NOT EXISTS "user.email" text');
    expect(plan!.addColumnsSql).toContain('ADD COLUMN IF NOT EXISTS "user.age" bigint');
    expect(plan!.addColumnsSql).toContain('ADD COLUMN IF NOT EXISTS "active" boolean');
    expect(plan!.widenColumnSql).toEqual([]);
    expect(plan!.insertSql).toContain('INSERT INTO "public"."events_flat"');
    expect(plan!.insertSql).toContain('"user.email"');
    expect(plan!.insertParams).toEqual(["a@b.test", 30, "signup", true]);
  });

  it("plans a WIDEN when an event's value type conflicts with the live column", () => {
    const plan = planDottedColumnInsert("t", { score: "high" }, types({ score: "bigint" }), {
      jsonbParams,
    });
    expect(plan!.adds).toEqual([]);
    expect(plan!.widens).toEqual([{ name: "score", type: "text" }]);
    expect(plan!.widenColumnSql).toEqual([
      'ALTER TABLE "public"."t" ALTER COLUMN "score" TYPE text USING "score"::text',
    ]);
  });

  it("encodes jsonb params per driver: JSON string for node-pg, raw value for postgres.js", () => {
    const plan = planDottedColumnInsert("t", { tags: ["a", "b"] }, types({}), { jsonbParams });
    expect(plan!.insertSql).toContain("$1::jsonb");
    expect(plan!.insertParams).toEqual(
      jsonbParams === "stringified" ? ['["a","b"]'] : [["a", "b"]],
    );
  });

  it("stringifies a jsonb-vs-text conflict into the text column (never narrows)", () => {
    // Arrays are jsonb LEAVES (objects recurse into dotted columns).
    const plan = planDottedColumnInsert("t", { meta: [1, 2] }, types({ meta: "text" }), {
      jsonbParams,
    });
    // jsonb value into a text column → effective type stays text, value stringified.
    expect(plan!.widens).toEqual([]);
    expect(plan!.effective.get("meta")).toBe("text");
    expect(plan!.insertParams).toEqual(["[1,2]"]);
  });

  it("returns null for an empty payload (nothing to insert)", () => {
    expect(planDottedColumnInsert("t", {}, types({}), { jsonbParams })).toBeNull();
  });

  it("plans the 42703 stale-cache repair from the fresh schema", () => {
    const plan = planDottedColumnInsert("t", { a: 1, b: "x" }, types({ a: "bigint", b: "text" }), {
      jsonbParams,
    });
    // Fresh read shows "b" was dropped externally — repair re-adds it with the
    // effective type; "a" survives so it isn't re-added.
    const repair = planColumnRepair("t", plan!, types({ a: "bigint" }));
    expect(repair.added).toEqual([{ name: "b", type: "text" }]);
    expect(repair.addColumnsSql).toBe(
      'ALTER TABLE "public"."t" ADD COLUMN IF NOT EXISTS "b" text',
    );
    // Nothing missing → no ALTER, caller just re-runs the INSERT.
    expect(planColumnRepair("t", plan!, types({ a: "bigint", b: "text" })).addColumnsSql).toBeNull();
  });
});
