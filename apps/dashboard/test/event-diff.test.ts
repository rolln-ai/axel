import { describe, expect, it } from "vitest";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import { findPreviousEventForSource } from "../lib/event-diff";

/**
 * Capturing client that records the exact SQL sent to ClickHouse, so we can
 * assert the query shape without a live ClickHouse.
 */
function capturingCh(rows: Array<Record<string, unknown>>) {
  let lastSql = "";
  const client: ClickhouseQueryable & { getLastSql: () => string } = {
    async query<T>(sql: string) {
      lastSql = sql;
      return { rows: rows as unknown as T[] };
    },
    getLastSql: () => lastSql,
  };
  return client;
}

describe("findPreviousEventForSource", () => {
  // Regression for a production-shaped ClickHouse type failure:
  //   Code: 43. No operation less between String and DateTime64(3).
  //
  // The "Schema diff vs. previous event" panel was dead for every event.
  // Root cause: the SELECT had `toString(received_at) AS received_at`, which
  // (because ClickHouse resolves SELECT-list aliases GLOBALLY, not
  // left-to-right) shadowed the underlying DateTime64 column in the WHERE
  // clause's `received_at < parseDateTime64BestEffort(...)` comparison —
  // comparing a String against DateTime64(3). Only renaming the alias fixes
  // it. Same class of bug as the data-contracts sampler's dateDiff failure.
  it("does not alias toString(received_at) back to the column name", async () => {
    const client = capturingCh([]);
    await findPreviousEventForSource("ws_1", "src_1", "2026-06-16 18:15:39.244", client);

    const sql = client.getLastSql();
    // The raw column must stay bound for the datetime comparison + ORDER BY.
    expect(sql).toContain("received_at < parseDateTime64BestEffort({before:String})");
    expect(sql).not.toMatch(/toString\(received_at\)\s+AS\s+received_at\b/);
    expect(sql).toMatch(/toString\(received_at\)\s+AS\s+received_at_text\b/);
  });

  it("maps the renamed alias back onto received_at in the result", async () => {
    const client = capturingCh([
      { event_id: "evt_prev", received_at_text: "2026-06-16 18:15:36.970", r2_key: "k/prev" },
    ]);
    const ref = await findPreviousEventForSource("ws_1", "src_1", "2026-06-16 18:15:39.244", client);

    expect(ref).toEqual({
      event_id: "evt_prev",
      received_at: "2026-06-16 18:15:36.970",
      r2_key: "k/prev",
    });
  });

  it("returns null when there is no previous event", async () => {
    const ref = await findPreviousEventForSource("ws_1", "src_1", "2026-06-16 18:15:39.244", capturingCh([]));
    expect(ref).toBeNull();
  });
});
