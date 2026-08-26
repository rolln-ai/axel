import { describe, expect, it } from "vitest";
import {
  countActiveReplayRequestsByReason,
  countUnresolvedDeadLettersByReason,
  getDashboardMetrics,
  listDeadLetters,
  listDeadLettersFull,
} from "../lib/repositories";
import type { Queryable } from "../lib/db";

describe("dashboard repositories", () => {
  it("builds metrics from workspace-scoped counts", async () => {
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(_sql: string, _params?: unknown[]) {
        return {
          rows: [{ sources: "2", active_sources: "1", routes: "3", destinations: "4", dead_letters: "1" }] as unknown as T[],
          rowCount: 1,
        };
      },
    };
    await expect(getDashboardMetrics("ws_1", fakeDb)).resolves.toEqual([
      { label: "Sources", value: "2" },
      { label: "Active sources", value: "1" },
      { label: "Routes", value: "3" },
      { label: "Destinations", value: "4" },
      { label: "Failed deliveries", value: "1" },
    ]);
  });

  // Regression guard: a successful replay should hide the corresponding
  // dead_letter from the "Delivery exceptions" UI. Replay success now writes
  // resolved_at onto dead_letters, so dashboard reads stay cheap and don't
  // need to anti-join replay history for every count.
  it("listDeadLetters filters out successfully replayed events", async () => {
    let capturedSql = "";
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]) {
        capturedSql = sql;
        return { rows: [] as unknown as T[], rowCount: 0 };
      },
    };
    await listDeadLetters("ws_1", fakeDb);
    expect(capturedSql).toMatch(/dl\.resolved_at IS NULL/);
    expect(capturedSql).not.toMatch(/NOT EXISTS/);
  });

  it("listDeadLettersFull filters out successfully replayed events", async () => {
    let capturedSql = "";
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]) {
        capturedSql = sql;
        return { rows: [] as unknown as T[], rowCount: 0 };
      },
    };
    await listDeadLettersFull("ws_1", fakeDb);
    expect(capturedSql).toMatch(/dl\.resolved_at IS NULL/);
    expect(capturedSql).not.toMatch(/NOT EXISTS/);
  });

  it("dashboard failed-deliveries metric also excludes replayed events", async () => {
    let capturedSql = "";
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]) {
        capturedSql = sql;
        return {
          rows: [{ sources: "2", active_sources: "1", routes: "3", destinations: "4", dead_letters: "1" }] as unknown as T[],
          rowCount: 1,
        };
      },
    };
    await getDashboardMetrics("ws_1", fakeDb);
    // All four counts now run as scalar subqueries in a single SQL
    // statement — check the dead-letter subquery is the gated one.
    expect(capturedSql).toMatch(/FROM dead_letters dl/);
    expect(capturedSql).toMatch(/dl\.resolved_at IS NULL/);
  });

  it("dashboard metrics include active-source count in the same round trip", async () => {
    let calls = 0;
    let capturedSql = "";
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]) {
        calls += 1;
        capturedSql = sql;
        return {
          rows: [{ sources: "4", active_sources: "3", routes: "2", destinations: "1", dead_letters: "0" }] as unknown as T[],
          rowCount: 1,
        };
      },
    };

    const rows = await getDashboardMetrics("ws_1", fakeDb);
    expect(calls).toBe(1);
    expect(rows.find((row) => row.label === "Active sources")?.value).toBe("3");
    expect(capturedSql).toMatch(/status = 'active'/);
  });

  it("active replay counts use denormalized failure reasons", async () => {
    let capturedSql = "";
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]) {
        capturedSql = sql;
        return {
          rows: [{ reason: "router_processing_failed", state: "pending", count: "7" }] as unknown as T[],
          rowCount: 1,
        };
      },
    };

    await expect(countActiveReplayRequestsByReason("ws_1", fakeDb)).resolves.toEqual([
      { reason: "router_processing_failed", state: "pending", count: 7 },
    ]);
    expect(capturedSql).toMatch(/failure_reason AS reason/);
    expect(capturedSql).not.toMatch(/JOIN dead_letters/);
  });

  it("reason breakdown includes all unresolved reasons for activity totals", async () => {
    let capturedSql = "";
    const fakeDb: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, _params?: unknown[]) {
        capturedSql = sql;
        return {
          rows: [
            {
              reason: "router_processing_failed",
              count: "70",
              sample_dead_letter_id: "1",
              sample_source_id: "src_1",
            },
            {
              reason: "rare_failure",
              count: "2",
              sample_dead_letter_id: "2",
              sample_source_id: "src_1",
            },
          ] as unknown as T[],
          rowCount: 2,
        };
      },
    };

    const rows = await countUnresolvedDeadLettersByReason("ws_1", fakeDb);
    expect(rows.reduce((sum, row) => sum + row.count, 0)).toBe(72);
    expect(capturedSql).toMatch(/dl\.resolved_at IS NULL/);
    expect(capturedSql).not.toMatch(/LIMIT\s+\d+/i);
  });
});
