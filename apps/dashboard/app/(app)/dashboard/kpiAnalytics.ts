import type { DailyDeliveryRow, DailyUsageRow } from "../../../lib/usage";

/**
 * Pure view-model for the analytics-backed KPI cards.
 *
 * The daily series arrive as `rows | null` — null when ClickHouse is not
 * configured, when the query errored, or when it outran the KPI row's
 * `resolveWithin` budget. Those must never be conflated with a genuinely
 * empty series: an empty workspace shows "0 · no events yet", a timed-out
 * query shows "—" (and the page schedules a soft refresh to recover).
 */

export interface SeriesKpi {
  /** False when the series was unavailable (timeout / error / unconfigured). */
  available: boolean;
  recent: number;
  delta: number | null;
}

export interface SuccessRateKpi {
  available: boolean;
  ratePct: number | null;
  delta: number | null;
}

export interface AnalyticsKpis {
  /** True when usage analytics are configured but a series failed to load. */
  degraded: boolean;
  events: SeriesKpi;
  deliveries: SeriesKpi;
  successRate: SuccessRateKpi;
  dead: SeriesKpi;
}

export function sumSlice(values: number[], start: number, end: number): number {
  return values.slice(start, end).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

export function deltaPct(values: number[]): number | null {
  if (values.length < 2) return null;
  const half = Math.floor(values.length / 2);
  const prior = sumSlice(values, 0, half);
  const recent = sumSlice(values, half, values.length);
  if (prior === 0) return null;
  return Math.round(((recent - prior) / prior) * 100);
}

/**
 * KpiCard renders deltaPct OR sub (not both). When delta is null we want a
 * meaningful caption: "no activity" if the period itself is empty, or
 * "no prior data" if there's a current value but nothing to compare against.
 */
export function emptyCaption(value: number, delta: number | null, ifEmpty: string): string | undefined {
  if (delta !== null) return undefined;
  return value === 0 ? ifEmpty : "no prior data";
}

/** Caption for a card whose series is unavailable. */
export function unavailableCaption(usageOn: boolean): string {
  return usageOn ? "analytics catching up" : "ClickHouse not configured";
}

export function computeAnalyticsKpis({
  dailyEvents,
  dailyDelivery,
  chartDays,
  usageOn,
}: {
  dailyEvents: DailyUsageRow[] | null | undefined;
  dailyDelivery: DailyDeliveryRow[] | null | undefined;
  chartDays: number;
  usageOn: boolean;
}): AnalyticsKpis {
  const eventsAvailable = Array.isArray(dailyEvents);
  const deliveryAvailable = Array.isArray(dailyDelivery);

  const eventsSeries = (dailyEvents ?? []).map((r) => r.events);
  const deliveriesSeries = (dailyDelivery ?? []).map((r) => r.success + r.retry + r.dead);
  const successSeries = (dailyDelivery ?? []).map((r) => r.success);
  const deadSeries = (dailyDelivery ?? []).map((r) => r.dead);

  const recent = (series: number[]) => sumSlice(series, series.length - chartDays, series.length);

  const recentSuccess = recent(successSeries);
  const recentTotal = recent(deliveriesSeries);
  const successRateRecent =
    deliveryAvailable && recentTotal > 0 ? (recentSuccess / recentTotal) * 100 : null;

  const priorSuccess = sumSlice(successSeries, 0, successSeries.length - chartDays);
  const priorTotal = sumSlice(deliveriesSeries, 0, deliveriesSeries.length - chartDays);
  const priorSuccessRate = priorTotal > 0 ? (priorSuccess / priorTotal) * 100 : null;

  return {
    degraded: usageOn && (!eventsAvailable || !deliveryAvailable),
    events: {
      available: eventsAvailable,
      recent: recent(eventsSeries),
      delta: deltaPct(eventsSeries),
    },
    deliveries: {
      available: deliveryAvailable,
      recent: recentTotal,
      delta: deltaPct(deliveriesSeries),
    },
    successRate: {
      available: deliveryAvailable,
      ratePct: successRateRecent,
      delta:
        successRateRecent !== null && priorSuccessRate !== null && priorSuccessRate > 0
          ? Math.round(successRateRecent - priorSuccessRate)
          : null,
    },
    dead: {
      available: deliveryAvailable,
      recent: recent(deadSeries),
      delta: deltaPct(deadSeries),
    },
  };
}
