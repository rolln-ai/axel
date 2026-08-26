import { describe, expect, it } from "vitest";
import { fakeClickhouse } from "@axel/test-utils";
import { runBillingRollup } from "../lib/billing/rollup";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import type { Queryable } from "../lib/db";

interface UpsertCall {
  workspaceId: string;
  periodStart: string;
  ingest: number;
  delivery: number;
}

function makeFakeCh(
  ingest: Array<{ workspace_id: string; tasks: string }>,
  delivery: Array<{ workspace_id: string; tasks: string }>,
): ClickhouseQueryable {
  // The rollup issues exactly two queries, ingest first.
  return fakeClickhouse({ responses: [ingest, delivery] }).client;
}

// `existing` lets a test simulate orphaned ClickHouse workspace_ids (a hard-
// deleted workspace): the rollup filters `merged` against the workspaces table
// before upserting. When omitted, every queried id is treated as live, so the
// existing tests behave exactly as before.
function makeFakePg(existing?: Set<string>): { pg: Queryable; calls: UpsertCall[] } {
  const calls: UpsertCall[] = [];
  const pg: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (/from\s+workspaces/i.test(sql)) {
        const ids = (params[0] as string[]) ?? [];
        const live = existing ? ids.filter((id) => existing.has(id)) : ids;
        return { rows: live.map((id) => ({ id })) as unknown as T[], rowCount: live.length };
      }
      calls.push({
        workspaceId: String(params[0]),
        periodStart: String(params[1]),
        ingest: Number(params[2]),
        delivery: Number(params[3]),
      });
      return { rows: [] as unknown as T[], rowCount: 0 };
    },
  };
  return { pg, calls };
}

describe("runBillingRollup", () => {
  it("merges ingest + delivery rows and upserts one row per workspace", async () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const ch = makeFakeCh(
      [
        { workspace_id: "ws_a", tasks: "1500" },
        { workspace_id: "ws_b", tasks: "8000" },
      ],
      [
        { workspace_id: "ws_a", tasks: "1200" },
        { workspace_id: "ws_c", tasks: "300" },
      ],
    );
    const { pg, calls } = makeFakePg();

    const summary = await runBillingRollup({ ch, pg, now });

    expect(summary.periodStart).toBe("2026-05-01");
    expect(summary.workspaceCount).toBe(3);
    expect(summary.ingestTasks).toBe(9500);
    expect(summary.deliveryTasks).toBe(1500);

    const byWs = new Map(calls.map((c) => [c.workspaceId, c]));
    expect(byWs.get("ws_a")).toMatchObject({
      ingest: 1500,
      delivery: 1200,
      periodStart: "2026-05-01",
    });
    expect(byWs.get("ws_b")).toMatchObject({ ingest: 8000, delivery: 0 });
    expect(byWs.get("ws_c")).toMatchObject({ ingest: 0, delivery: 300 });
  });

  it("dedupes billable counts with uniqExact (not count()) so at-least-once requeues don't overbill", async () => {
    const sqls: string[] = [];
    const ch: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(sql: string) {
        sqls.push(sql);
        return { rows: [] as unknown as T[] };
      },
    };
    const { pg } = makeFakePg();
    await runBillingRollup({ ch, pg, now: new Date("2026-05-15T12:00:00Z") });

    // events / delivery_attempts are plain MergeTree + at-least-once queues, so
    // count() would inflate the invoice past the deduplicated /usage dashboard
    // number. Both billable aggregates must use uniqExact over the event identity.
    const ingestSql = sqls.find((s) => /FROM\s+events\b/i.test(s)) ?? "";
    const deliverySql = sqls.find((s) => /FROM\s+delivery_attempts\b/i.test(s)) ?? "";
    expect(ingestSql).toMatch(/uniqExact\(event_id\)/);
    expect(ingestSql).not.toMatch(/count\(\)/);
    expect(deliverySql).toMatch(/uniqExact\(event_id, route_id, destination_id\)/);
    expect(deliverySql).not.toMatch(/count\(\)/);
  });

  it("skips workspace_ids missing from Postgres so orphaned ClickHouse rows can't FK-violate the upsert", async () => {
    // A hard-deleted workspace leaves its events/delivery_attempts in ClickHouse
    // (deleteWorkspaceAction never wipes CH). Those orphan ids must be dropped
    // before the upsert, or the FK to workspaces rolls back the whole rollup.
    const now = new Date("2026-05-15T12:00:00Z");
    const ch = makeFakeCh(
      [
        { workspace_id: "ws_live", tasks: "100" },
        { workspace_id: "ws_deleted", tasks: "999" },
      ],
      [{ workspace_id: "ws_deleted", tasks: "5" }],
    );
    const { pg, calls } = makeFakePg(new Set(["ws_live"]));

    const summary = await runBillingRollup({ ch, pg, now });

    expect(calls.map((c) => c.workspaceId)).toEqual(["ws_live"]); // orphan never upserted
    expect(summary.workspaceCount).toBe(1);
    expect(summary.ingestTasks).toBe(100); // totals exclude the orphan's tasks
    expect(summary.deliveryTasks).toBe(0);
  });

  it("uses the calendar-month UTC anchor regardless of intra-month time", async () => {
    const lateInMonth = new Date("2026-05-31T23:59:59Z");
    const ch = makeFakeCh([{ workspace_id: "ws_x", tasks: "1" }], []);
    const { pg, calls } = makeFakePg();
    const summary = await runBillingRollup({ ch, pg, now: lateInMonth });
    expect(summary.periodStart).toBe("2026-05-01");
    expect(calls.at(0)?.periodStart).toBe("2026-05-01");
  });

  it("does not write rows when ClickHouse returns no activity", async () => {
    const ch = makeFakeCh([], []);
    const { pg, calls } = makeFakePg();
    const summary = await runBillingRollup({
      ch,
      pg,
      now: new Date("2026-05-15T00:00:00Z"),
    });
    expect(summary.workspaceCount).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("coerces ClickHouse string counts and clamps negatives to zero", async () => {
    // CH returns count() as a string in JSON; future schema drift
    // could surface a non-numeric token. Both should land at >=0.
    const ch = makeFakeCh(
      [
        { workspace_id: "ws_str", tasks: "42" },
        { workspace_id: "ws_neg", tasks: "-7" },
        { workspace_id: "ws_nan", tasks: "not-a-number" },
      ],
      [],
    );
    const { pg, calls } = makeFakePg();
    await runBillingRollup({ ch, pg, now: new Date("2026-05-15T00:00:00Z") });
    const byWs = new Map(calls.map((c) => [c.workspaceId, c]));
    expect(byWs.get("ws_str")?.ingest).toBe(42);
    expect(byWs.get("ws_neg")?.ingest).toBe(0);
    expect(byWs.get("ws_nan")?.ingest).toBe(0);
  });

  it("is idempotent — running twice over identical CH data produces identical upserts", async () => {
    const now = new Date("2026-05-15T12:00:00Z");
    const ingest = [{ workspace_id: "ws_a", tasks: "100" }];
    const delivery = [{ workspace_id: "ws_a", tasks: "50" }];

    const first = makeFakePg();
    await runBillingRollup({
      ch: makeFakeCh(ingest, delivery),
      pg: first.pg,
      now,
    });

    const second = makeFakePg();
    await runBillingRollup({
      ch: makeFakeCh(ingest, delivery),
      pg: second.pg,
      now,
    });

    expect(second.calls).toEqual(first.calls);
  });

  it("crosses month boundaries cleanly — Dec 31 → period 2026-12-01, Jan 1 → 2027-01-01", async () => {
    const ch = makeFakeCh([{ workspace_id: "ws_a", tasks: "1" }], []);

    const dec = makeFakePg();
    await runBillingRollup({
      ch: makeFakeCh([{ workspace_id: "ws_a", tasks: "1" }], []),
      pg: dec.pg,
      now: new Date("2026-12-31T23:00:00Z"),
    });
    expect(dec.calls.at(0)?.periodStart).toBe("2026-12-01");

    const jan = makeFakePg();
    await runBillingRollup({
      ch,
      pg: jan.pg,
      now: new Date("2027-01-01T00:30:00Z"),
    });
    expect(jan.calls.at(0)?.periodStart).toBe("2027-01-01");
  });
});
