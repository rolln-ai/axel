import { describe, expect, it } from "vitest";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import {
  OUTCOME_SKIP_PREDICATE,
  SKIP_PREDICATE,
  SUCCESS_PREDICATE,
  TERMINAL_FAILURE_PREDICATE,
  latestOutcomesCTE,
} from "../lib/clickhouse-fragments";
import {
  getDailyDestinationDeliveryStats,
  getDestinationDeliverySummary,
  getDestinationEdaSeries,
  getDestinationLastDelivery,
  getDestinationLatencyPercentiles,
  getDestinationResponseCodeDistribution,
  getDestinationRouteHealth,
  listRecentDestinationAttempts,
} from "../lib/destination-metrics";

interface CapturedCall {
  sql: string;
  params: Record<string, string | number>;
}

function fakeClickhouse({ responses }: { responses: Array<unknown> }): {
  client: ClickhouseQueryable;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  let cursor = 0;
  const client: ClickhouseQueryable = {
    async query(sql, params = {}) {
      calls.push({ sql, params });
      const next = responses[cursor++] ?? [];
      if (next instanceof Error) throw next;
      return { rows: next as never };
    },
  };
  return { client, calls };
}

const NOW = new Date("2026-05-15T12:00:00Z");

/** The exact CTE every destination-scoped outcome query must be built from. */
const DEST_CTE = latestOutcomesCTE({ source: "attempts", scope: { destination: true } });

describe("destination-metrics", () => {
  it("getDestinationDeliverySummary counts canonical latest outcomes and keeps latency attempt-level", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [{ attempts: "10", success: "7", retry: "1", dead: "1", skipped: "2" }],
        [{ avg_latency_ms: "120.5", last_attempt_at: "2026-05-15 11:59:00.000" }],
      ],
    });

    const summary = await getDestinationDeliverySummary("ws_test", "dst_test", 24, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(summary).toEqual({
      attempts: 10,
      success: 7,
      retry: 1,
      dead: 1,
      skipped: 2,
      // Skip-latest outcomes are excluded from the denominator (ROL-628).
      successRate: 7 / 8,
      avgLatencyMs: 120.5,
      lastAttemptAt: "2026-05-15 11:59:00.000",
    });

    // Outcome counts come from the canonical CTE, test traffic excluded.
    const outcomesSql = calls[0]!.sql;
    expect(outcomesSql).toContain(
      latestOutcomesCTE({ source: "attempts", scope: { destination: true, excludeTest: true } }),
    );
    expect(outcomesSql).toContain(SUCCESS_PREDICATE);
    expect(outcomesSql).toContain(TERMINAL_FAILURE_PREDICATE);
    expect(outcomesSql).toContain(OUTCOME_SKIP_PREDICATE);
    expect(outcomesSql).toContain("is_test = 0");
    expect(outcomesSql).toContain("replaceRegexpOne(event_id, '#rpy_[A-Za-z0-9_-]+$', '')");

    // Latency + last-attempt stay attempt-level, skips excluded from latency.
    const attemptSql = calls[1]!.sql;
    expect(attemptSql).toContain("FROM delivery_attempts");
    expect(attemptSql).not.toContain("GROUP BY base_event_id");
    expect(attemptSql).toContain(`avgIf(latency_ms, status != 'dead' AND NOT ${SKIP_PREDICATE})`);

    for (const call of calls) {
      expect(call.params).toMatchObject({ workspace_id: "ws_test", destination_id: "dst_test" });
      expect(call.sql).toContain("destination_id = {destination_id:String}");
    }
  });

  it("every destination outcome surface embeds the identical canonical CTE", async () => {
    const surfaces: Array<(client: ClickhouseQueryable) => Promise<unknown>> = [
      (client) => getDailyDestinationDeliveryStats("ws_test", "dst_test", 14, { clickhouse: client, now: () => NOW }),
      (client) => getDestinationLatencyPercentiles("ws_test", "dst_test", 24, { clickhouse: client, now: () => NOW }),
      (client) => getDestinationResponseCodeDistribution("ws_test", "dst_test", 24, { clickhouse: client, now: () => NOW }),
      (client) => getDestinationRouteHealth("ws_test", "dst_test", 24, { clickhouse: client, now: () => NOW }),
      (client) => getDestinationEdaSeries("ws_test", "dst_test", "hour", 24, { clickhouse: client, now: () => NOW }),
    ];

    for (const run of surfaces) {
      const { client, calls } = fakeClickhouse({ responses: [[]] });
      await run(client);
      expect(calls[0]!.sql).toContain(DEST_CTE);
      expect(calls[0]!.sql).toContain("GROUP BY base_event_id, route_id, destination_id");
      expect(calls[0]!.params).toMatchObject({ workspace_id: "ws_test", destination_id: "dst_test" });
    }
  });

  it("getDestinationLatencyPercentiles measures final attempts, excluding terminal failures and skips", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [[{ p50: "80", p95: "300", p99: "900", max_latency: "1500", count: "42" }]],
    });

    const result = await getDestinationLatencyPercentiles("ws_test", "dst_test", 24, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(result).toEqual({ p50: 80, p95: 300, p99: 900, max: 1500, count: 42 });
    expect(calls[0]!.sql).toContain("quantile(0.5)(outcome_latency_ms)");
    expect(calls[0]!.sql).toContain(`NOT ${TERMINAL_FAILURE_PREDICATE}`);
    expect(calls[0]!.sql).toContain(`NOT ${OUTCOME_SKIP_PREDICATE}`);
  });

  it("getDestinationResponseCodeDistribution buckets only unresolved outcomes", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          { response_json: JSON.stringify({ http_status: 503 }), status: "retry", c: "4" },
          { response_json: JSON.stringify({ error: "connection refused" }), status: "dead", c: "2" },
        ],
      ],
    });

    const buckets = await getDestinationResponseCodeDistribution("ws_test", "dst_test", 24, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(buckets).toEqual([
      { bucket: "503", count: 4, tone: "error" },
      { bucket: "connection refused", count: 2, tone: "error" },
    ]);
    // already_delivered dead-letters and retries-that-recovered are excluded
    // in SQL, matching the workspace failure-type breakdown.
    expect(calls[0]!.sql).toContain(`NOT ${SUCCESS_PREDICATE}`);
    expect(calls[0]!.sql).toContain("GROUP BY outcome_response, outcome_status");
  });

  it("getDestinationRouteHealth computes success rate over outcomes with already_delivered as success", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          {
            route_id: "rt_1",
            success: "9",
            retry: "0",
            dead: "1",
            avg_latency_ms: "150",
            last_attempt_at: "2026-05-15 11:58:00.000",
          },
        ],
      ],
    });

    const rows = await getDestinationRouteHealth("ws_test", "dst_test", 24, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(rows).toEqual([
      {
        route_id: "rt_1",
        success: 9,
        retry: 0,
        dead: 1,
        total: 10,
        successRate: 0.9,
        avgLatencyMs: 150,
        lastAttemptAt: "2026-05-15 11:58:00.000",
      },
    ]);
    expect(calls[0]!.sql).toContain(SUCCESS_PREDICATE);
    expect(calls[0]!.sql).toContain(TERMINAL_FAILURE_PREDICATE);
    expect(calls[0]!.sql).toContain("GROUP BY route_id");
  });

  it("getDailyDestinationDeliveryStats buckets outcomes by the day the outcome landed", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [{ day: "2026-05-15", success: "10", retry: "1", dead: "2", p50_latency_ms: "90", p95_latency_ms: "400" }],
      ],
    });

    const rows = await getDailyDestinationDeliveryStats("ws_test", "dst_test", 14, {
      clickhouse: client,
      now: () => NOW,
      timezone: "America/Denver",
    });

    expect(rows).toEqual([
      { day: "2026-05-15", success: 10, retry: 1, dead: 2, p50_latency_ms: 90, p95_latency_ms: 400 },
    ]);
    expect(calls[0]!.sql).toContain("toDate(outcome_at, {timezone:String})");
    expect(calls[0]!.sql).toContain("quantile(0.5)(outcome_latency_ms)");
    expect(calls[0]!.params.timezone).toBe("America/Denver");
  });

  it("getDestinationEdaSeries groups outcome columns per dimension", async () => {
    const expectations: Array<["hour" | "route" | "status" | "attempt_no", string]> = [
      ["hour", "toStartOfInterval(outcome_at, INTERVAL 1 HOUR, {timezone:String})"],
      ["route", "route_id"],
      ["status", "outcome_status"],
      ["attempt_no", "toString(outcome_attempt_no)"],
    ];

    for (const [dimension, bucketExpr] of expectations) {
      const { client, calls } = fakeClickhouse({ responses: [[]] });
      await getDestinationEdaSeries("ws_test", "dst_test", dimension, 24, {
        clickhouse: client,
        now: () => NOW,
      });
      expect(calls[0]!.sql).toContain(`${bucketExpr}`);
      expect(calls[0]!.sql).toContain(SUCCESS_PREDICATE);
      expect(calls[0]!.sql).toContain(DEST_CTE);
    }
  });

  it("listRecentDestinationAttempts stays a raw attempts log (no outcome dedup)", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[]] });

    await listRecentDestinationAttempts("ws_test", "dst_test", 25, { clickhouse: client }, true);

    expect(calls[0]!.sql).toContain("FROM delivery_attempts");
    expect(calls[0]!.sql).not.toContain("GROUP BY base_event_id");
    expect(calls[0]!.sql).not.toContain("argMax");
    expect(calls[0]!.sql).toContain("AND status != 'success'");
  });

  it("getDestinationLastDelivery ignores skip rows so a paused destination doesn't look live", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [[{ last_attempt_at: "2026-05-15 10:00:00.000" }]],
    });

    const result = await getDestinationLastDelivery("ws_test", "dst_test", { clickhouse: client });

    expect(result).toEqual({ lastAttemptAt: "2026-05-15 10:00:00.000" });
    expect(calls[0]!.sql).toContain(`NOT ${SKIP_PREDICATE}`);
  });
});
