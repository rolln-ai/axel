import { describe, expect, it } from "vitest";
import { capturingPg, fakeClickhouse, fakeSession } from "../src/index";

describe("capturingPg", () => {
  it("consumes the FIFO in order, capturing every call", async () => {
    const pg = capturingPg({
      responses: [{ rows: [{ id: "a" }] }, { rows: [], rowCount: 3 }],
    });
    await expect(pg.query("SELECT 1", ["x"])).resolves.toEqual({
      rows: [{ id: "a" }],
      rowCount: 1,
    });
    await expect(pg.query("UPDATE t")).resolves.toEqual({ rows: [], rowCount: 3 });
    // Exhausted FIFO answers empty.
    await expect(pg.query("SELECT 2")).resolves.toEqual({ rows: [], rowCount: 0 });
    expect(pg.calls).toEqual([
      { sql: "SELECT 1", params: ["x"] },
      { sql: "UPDATE t", params: [] },
      { sql: "SELECT 2", params: [] },
    ]);
  });

  it("rejects when the next scripted response is an Error", async () => {
    const pg = capturingPg({ responses: [new Error("boom")] });
    await expect(pg.query("INSERT")).rejects.toThrow("boom");
  });

  it("answers intercepted queries without consuming the FIFO", async () => {
    const pg = capturingPg({
      responses: [{ rows: [{ id: "scripted" }] }],
      intercept: (sql) => (/gate/.test(sql) ? { rows: [{ ok: true }] } : undefined),
    });
    await expect(pg.query("SELECT gate")).resolves.toEqual({
      rows: [{ ok: true }],
      rowCount: 1,
    });
    await expect(pg.query("SELECT next")).resolves.toEqual({
      rows: [{ id: "scripted" }],
      rowCount: 1,
    });
    expect(pg.calls).toHaveLength(2);
  });

  it("dbModule() shares one capturing client between db() and withTransaction", async () => {
    const pg = capturingPg();
    const mod = pg.dbModule();
    await mod.db().query("SELECT 1");
    const out = await mod.withTransaction(async (client) => {
      await client.query("UPDATE t", [1]);
      return "done";
    });
    expect(out).toBe("done");
    expect(pg.calls.map((c) => c.sql)).toEqual(["SELECT 1", "UPDATE t"]);
  });

  it("reset() clears calls and unconsumed responses", async () => {
    const pg = capturingPg({ responses: [{ rows: [{ id: 1 }] }] });
    await pg.query("SELECT 1");
    pg.responses.push({ rows: [] });
    pg.reset();
    expect(pg.calls).toEqual([]);
    expect(pg.responses).toEqual([]);
  });
});

describe("fakeClickhouse", () => {
  it("FIFO mode: consumes responses in order and captures sql + params", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[{ n: "1" }]] });
    await expect(client.query("SELECT n", { workspace_id: "ws_1" })).resolves.toEqual({
      rows: [{ n: "1" }],
    });
    // Exhausted FIFO answers empty.
    await expect(client.query("SELECT 2")).resolves.toEqual({ rows: [] });
    expect(calls).toEqual([
      { sql: "SELECT n", params: { workspace_id: "ws_1" } },
      { sql: "SELECT 2", params: {} },
    ]);
  });

  it("FIFO mode: an Error entry rejects that query", async () => {
    const { client } = fakeClickhouse({ responses: [new Error("UNKNOWN_TABLE"), []] });
    await expect(client.query("SELECT 1")).rejects.toThrow("UNKNOWN_TABLE");
    await expect(client.query("SELECT 2")).resolves.toEqual({ rows: [] });
  });

  it("router mode: derives rows from the sql", async () => {
    const { client, calls } = fakeClickhouse({
      responses: (sql) => (sql.includes("FROM events") ? [{ day: "2026-01-01" }] : []),
    });
    await expect(client.query("SELECT * FROM events")).resolves.toEqual({
      rows: [{ day: "2026-01-01" }],
    });
    await expect(client.query("SELECT * FROM delivery_attempts")).resolves.toEqual({ rows: [] });
    expect(calls).toHaveLength(2);
  });
});

describe("fakeSession", () => {
  it("defaults to an owner on active workspace ws_1", () => {
    expect(fakeSession()).toEqual({
      user: { id: "usr_1" },
      activeWorkspace: { workspace_id: "ws_1", role: "owner", workspace_status: "active" },
    });
  });

  it("applies the role and merges overrides", () => {
    const session = fakeSession("member", {
      user: { email: "m@example.com" },
      activeWorkspace: { workspace_status: "suspended" },
      impersonator: null,
    });
    expect(session).toEqual({
      user: { id: "usr_1", email: "m@example.com" },
      activeWorkspace: { workspace_id: "ws_1", role: "member", workspace_status: "suspended" },
      impersonator: null,
    });
  });
});
