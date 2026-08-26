import { describe, expect, it } from "vitest";
import {
  computeAnalyticsKpis,
  deltaPct,
  emptyCaption,
  sumSlice,
  unavailableCaption,
} from "../app/(app)/dashboard/kpiAnalytics";

const CHART_DAYS = 14;
const DELTA_DAYS = CHART_DAYS * 2;

function usageRows(events: number[]) {
  return events.map((value, i) => ({ day: `2026-06-${String(i + 1).padStart(2, "0")}`, events: value, bytes: value * 100 }));
}

function deliveryRows(rows: Array<{ success: number; retry?: number; dead?: number }>) {
  return rows.map((row, i) => ({
    day: `2026-06-${String(i + 1).padStart(2, "0")}`,
    success: row.success,
    retry: row.retry ?? 0,
    dead: row.dead ?? 0,
  }));
}

describe("computeAnalyticsKpis", () => {
  it("marks series unavailable (not zero) when analytics timed out", () => {
    // Regression: a ClickHouse query that outran the KPI render budget
    // resolves to null. That must NOT render as "0 · no events yet" while
    // the chart on the same page (longer budget) shows millions of events.
    const kpis = computeAnalyticsKpis({
      dailyEvents: null,
      dailyDelivery: null,
      chartDays: CHART_DAYS,
      usageOn: true,
    });

    expect(kpis.degraded).toBe(true);
    expect(kpis.events.available).toBe(false);
    expect(kpis.deliveries.available).toBe(false);
    expect(kpis.successRate.available).toBe(false);
    expect(kpis.successRate.ratePct).toBeNull();
    expect(kpis.dead.available).toBe(false);
  });

  it("treats a genuinely empty workspace as available zeros", () => {
    const kpis = computeAnalyticsKpis({
      dailyEvents: usageRows(Array(DELTA_DAYS).fill(0)),
      dailyDelivery: deliveryRows(Array(DELTA_DAYS).fill({ success: 0 })),
      chartDays: CHART_DAYS,
      usageOn: true,
    });

    expect(kpis.degraded).toBe(false);
    expect(kpis.events).toEqual({ available: true, recent: 0, delta: null });
    expect(kpis.deliveries).toEqual({ available: true, recent: 0, delta: null });
    expect(kpis.successRate).toEqual({ available: true, ratePct: null, delta: null });
  });

  it("degrades partially when only one series timed out", () => {
    const kpis = computeAnalyticsKpis({
      dailyEvents: usageRows(Array(DELTA_DAYS).fill(100)),
      dailyDelivery: null,
      chartDays: CHART_DAYS,
      usageOn: true,
    });

    expect(kpis.degraded).toBe(true);
    expect(kpis.events.available).toBe(true);
    expect(kpis.events.recent).toBe(100 * CHART_DAYS);
    expect(kpis.deliveries.available).toBe(false);
    expect(kpis.successRate.available).toBe(false);
  });

  it("is not degraded when usage analytics are not configured at all", () => {
    const kpis = computeAnalyticsKpis({
      dailyEvents: null,
      dailyDelivery: null,
      chartDays: CHART_DAYS,
      usageOn: false,
    });

    // Unconfigured is a steady state — no auto-refresh loop, just the
    // "ClickHouse not configured" caption.
    expect(kpis.degraded).toBe(false);
    expect(kpis.events.available).toBe(false);
  });

  it("computes recent windows, deltas, and success rate from populated series", () => {
    // Prior 14 days: 50 events/day; recent 14 days: 100 events/day → +100%.
    const events = [...Array(CHART_DAYS).fill(50), ...Array(CHART_DAYS).fill(100)];
    // Prior: 90 success / 10 dead per day; recent: 99 success / 1 dead per day.
    const delivery = [
      ...Array(CHART_DAYS).fill({ success: 90, dead: 10 }),
      ...Array(CHART_DAYS).fill({ success: 99, dead: 1 }),
    ];

    const kpis = computeAnalyticsKpis({
      dailyEvents: usageRows(events),
      dailyDelivery: deliveryRows(delivery),
      chartDays: CHART_DAYS,
      usageOn: true,
    });

    expect(kpis.degraded).toBe(false);
    expect(kpis.events).toEqual({ available: true, recent: 100 * CHART_DAYS, delta: 100 });
    expect(kpis.deliveries.recent).toBe(100 * CHART_DAYS);
    expect(kpis.successRate.ratePct).toBe(99);
    expect(kpis.successRate.delta).toBe(9); // 99% − 90%
    expect(kpis.dead.recent).toBe(1 * CHART_DAYS);
  });
});

describe("captions", () => {
  it("unavailableCaption distinguishes slow analytics from unconfigured", () => {
    expect(unavailableCaption(true)).toBe("analytics catching up");
    expect(unavailableCaption(false)).toBe("ClickHouse not configured");
  });

  it("emptyCaption keeps its existing contract", () => {
    expect(emptyCaption(0, null, "no events yet")).toBe("no events yet");
    expect(emptyCaption(5, null, "no events yet")).toBe("no prior data");
    expect(emptyCaption(5, 12, "no events yet")).toBeUndefined();
  });
});

describe("series math", () => {
  it("sumSlice ignores non-finite values", () => {
    expect(sumSlice([1, Number.NaN, 3], 0, 3)).toBe(4);
  });

  it("deltaPct returns null without a prior period", () => {
    expect(deltaPct([])).toBeNull();
    expect(deltaPct([5])).toBeNull();
    expect(deltaPct([0, 0, 10, 10])).toBeNull(); // prior sum 0 → no delta
    expect(deltaPct([10, 10, 20, 20])).toBe(100);
  });
});
