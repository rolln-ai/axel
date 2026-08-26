import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { enforceRetention } from "../src/retention.ts";

interface PgCall {
  sql: string;
  params: unknown[];
}

/**
 * Pool that matches each query SQL against ordered rules and replays a
 * per-rule sequence of row counts. Unmatched queries return 0 rows — i.e. an
 * empty DB. Workspace-retention SELECTs read `rows.length`, so we materialise
 * that many `row_tid` rows.
 */
function scriptedPool(rules: Array<{ match: RegExp; counts: number[] }>): {
  pool: Pool;
  calls: PgCall[];
  countMatching: (re: RegExp) => number;
} {
  const calls: PgCall[] = [];
  const cursors = new Map<number, number>();
  const pool = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      for (let i = 0; i < rules.length; i += 1) {
        if (rules[i]!.match.test(sql)) {
          const c = cursors.get(i) ?? 0;
          cursors.set(i, c + 1);
          const n = rules[i]!.counts[c] ?? 0;
          return { rows: Array.from({ length: n }, (_, k) => ({ row_tid: `t${k}` })), rowCount: n };
        }
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as Pool;
  const countMatching = (re: RegExp) => calls.filter((call) => re.test(call.sql)).length;
  return { pool, calls, countMatching };
}

const FROZEN_CLOCK = () => 0;

describe("enforceRetention — drain", () => {
  it("drains an expiry category until a pass returns fewer than the limit", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /DELETE FROM delivery_idempotency/, counts: [2, 2, 1] },
    ]);

    const summary = await enforceRetention(pool, {
      limitPerCategory: 2,
      drain: true,
      clock: FROZEN_CLOCK,
    });

    expect(summary.delivery_idempotency_deleted).toBe(5);
    expect(countMatching(/DELETE FROM delivery_idempotency/)).toBe(3);
  });

  it("drains a workspace-retention category (SELECT + DELETE per pass)", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /dead_letters dl/, counts: [2, 2, 1] }, // SELECT (aliased)
      { match: /DELETE FROM dead_letters/, counts: [2, 2, 1] }, // DELETE
    ]);

    const summary = await enforceRetention(pool, {
      limitPerCategory: 2,
      drain: true,
      clock: FROZEN_CLOCK,
    });

    expect(summary.dead_letters_deleted).toBe(5);
    expect(countMatching(/DELETE FROM dead_letters/)).toBe(3);
  });

  it("without drain, runs exactly one pass per category", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /DELETE FROM delivery_idempotency/, counts: [5] }, // > limit
    ]);

    const summary = await enforceRetention(pool, { limitPerCategory: 2 }); // drain defaults off

    expect(summary.delivery_idempotency_deleted).toBe(5);
    expect(countMatching(/DELETE FROM delivery_idempotency/)).toBe(1);
  });

  it("stops draining when the tick budget is exhausted", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /DELETE FROM delivery_idempotency/, counts: [5, 5, 5, 5] }, // always full
    ]);

    // deadline = clock() + 0; the post-pass check clock() >= deadline is true
    // immediately, so it stops after a single pass despite a full batch.
    const summary = await enforceRetention(pool, {
      limitPerCategory: 2,
      drain: true,
      tickBudgetMs: 0,
      clock: () => 1000,
    });

    expect(summary.delivery_idempotency_deleted).toBe(5);
    expect(countMatching(/DELETE FROM delivery_idempotency/)).toBe(1);
  });

  it("caps drain passes at maxPassesPerCategory", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /DELETE FROM delivery_idempotency/, counts: [2, 2, 2, 2, 2] }, // never drains
    ]);

    const summary = await enforceRetention(pool, {
      limitPerCategory: 2,
      drain: true,
      maxPassesPerCategory: 3,
      clock: FROZEN_CLOCK, // budget never hit
    });

    expect(summary.delivery_idempotency_deleted).toBe(6);
    expect(countMatching(/DELETE FROM delivery_idempotency/)).toBe(3);
  });

  it("dryRun counts without issuing any DELETE", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /dead_letters dl/, counts: [3] }, // SELECT finds 3
    ]);

    const summary = await enforceRetention(pool, { dryRun: true });

    expect(summary.dead_letters_deleted).toBe(3); // foundCount, not deleted
    expect(countMatching(/DELETE FROM/)).toBe(0);
  });

  it("purges the erasure_subjects index by fixed age (received_at)", async () => {
    const { pool, countMatching } = scriptedPool([
      { match: /FROM erasure_subjects/, counts: [4] },
    ]);

    const summary = await enforceRetention(pool, { limitPerCategory: 100, clock: FROZEN_CLOCK });

    expect(summary.erasure_subjects_deleted).toBe(4);
    expect(countMatching(/DELETE FROM erasure_subjects[\s\S]*received_at </)).toBe(1);
  });
});
