import { describe, expect, it } from "vitest";
import { historicalGapAllowance, type FlowHistoryBucket } from "../lib/source-gap-history";
import { impactMessage, sourceSilenceObservation, type FlowSource } from "../lib/impact-alert-policy";

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const monday = Date.parse("2030-01-28T00:00:00Z");
const source: FlowSource = { id: "src_a", name: "Orders", created_at: "2030-01-01", alert_after_minutes: null, flow_monitoring_enabled: true };

// Exact bucket endpoints for a feed active every minute during business hours.
function businessHours(until: number, weekdaysOnly = false): FlowHistoryBucket[] {
  const rows: FlowHistoryBucket[] = [];
  for (let day = monday - 28 * DAY; day <= until; day += DAY) {
    if (weekdaysOnly && [0, 6].includes(new Date(day).getUTCDay())) continue;
    for (let minute = 9 * 60; minute < 17 * 60; minute += 15) {
      const first = day + minute * MINUTE;
      const last = first + 14 * MINUTE;
      if (last <= until) rows.push([first, last]);
    }
  }
  return rows;
}

describe("historical source gaps", () => {
  it("allows recurring overnight silence despite thousands of tightly spaced daytime events", () => {
    const last = monday + (17 * 60 - 1) * MINUTE;
    const activity = { source_id: source.id, last_received: new Date(last).toISOString(), samples: 2000,
      typical_gap_seconds: 60, history: businessHours(last) };
    const overnight = sourceSilenceObservation(source, activity, last + 12 * 60 * MINUTE)!;
    expect(overnight.unhealthy).toBe(false);
    expect(overnight.snapshot.thresholdMinutes).toBe(1202);
    expect(overnight.snapshot.thresholdBasis).toBe("historical_pattern");
    expect(sourceSilenceObservation(source, activity, last + 21 * 60 * MINUTE)?.unhealthy).toBe(true);
    expect(impactMessage("source_silent", overnight.snapshot, "opened").body).toContain("recurring quiet periods");
  });

  it("still detects an unexpected daytime stop on a feed with normal overnight gaps", () => {
    const last = monday + (12 * 60 - 1) * MINUTE;
    const result = sourceSilenceObservation(source, { source_id: source.id, last_received: new Date(last).toISOString(),
      samples: 2000, typical_gap_seconds: 60, history: businessHours(last) }, last + 31 * MINUTE)!;
    expect(result.unhealthy).toBe(true);
    expect(result.snapshot.thresholdMinutes).toBe(30);
  });

  it("learns a recurring weekend closure from matching weekdays without extending Monday to a weekend", () => {
    const friday = monday - 3 * DAY + (17 * 60 - 1) * MINUTE;
    const history = businessHours(friday, true);
    expect(historicalGapAllowance(history, friday) / MINUTE).toBeCloseTo(4801.25);
    const mondayClose = monday + (17 * 60 - 1) * MINUTE;
    expect(historicalGapAllowance(businessHours(mondayClose, true), mondayClose) / MINUTE).toBeCloseTo(1201.25);
  });

  it("requires separate dates and does not learn one multi-day outage as several quiet periods", () => {
    const last = monday + (12 * 60 - 1) * MINUTE;
    const history = businessHours(last).filter(([first]) => Number(first) < monday - 8 * DAY || Number(first) > monday - 2 * DAY);
    expect(historicalGapAllowance(history, last)).toBe(0);
    const shortHistory = businessHours(last).filter(([first]) => Number(first) >= monday - 5 * DAY);
    expect(historicalGapAllowance(shortHistory, last)).toBe(0);
  });

  it("does not infer a recurring daytime gap from only two unusual stops", () => {
    const last = monday + (12 * 60 - 1) * MINUTE;
    const history = businessHours(last).filter(([first]) => ![7, 14].some(days =>
      Number(first) >= monday - days * DAY + 12 * 60 * MINUTE && Number(first) < monday - days * DAY + 15 * 60 * MINUTE));
    expect(historicalGapAllowance(history, last)).toBe(0);
  });

  it("counts repeated daytime quiet periods but keeps weekday and weekend patterns separate", () => {
    const last = monday + (12 * 60 - 1) * MINUTE;
    const withGaps = (days: number[]) => businessHours(last).filter(([first]) => !days.some(day =>
      Number(first) >= monday - day * DAY + 12 * 60 * MINUTE && Number(first) < monday - day * DAY + 14 * 60 * MINUTE));
    expect(historicalGapAllowance(withGaps([7, 14, 21]), last) / MINUTE).toBeCloseTo(151.25);
    expect(historicalGapAllowance(withGaps([1, 8, 15, 22]), last)).toBe(0);
  });

  it("does not lengthen the window while the current gap grows", () => {
    const last = monday + (12 * 60 - 1) * MINUTE;
    const activity = { source_id: source.id, last_received: new Date(last).toISOString(), samples: 2000,
      typical_gap_seconds: 60, history: businessHours(last) };
    expect(sourceSilenceObservation(source, activity, last + 31 * MINUTE)?.snapshot.thresholdMinutes).toBe(30);
    expect(sourceSilenceObservation(source, activity, last + 3 * DAY)?.snapshot.thresholdMinutes).toBe(30);
  });

  it("honors explicit limits and the seven-day automatic ceiling", () => {
    const last = monday + (17 * 60 - 1) * MINUTE;
    const activity = { source_id: source.id, last_received: new Date(last).toISOString(), samples: 2000,
      typical_gap_seconds: 60, history: businessHours(last) };
    const explicit = sourceSilenceObservation({ ...source, alert_after_minutes: 45 }, activity, last + 46 * MINUTE)!;
    expect(explicit.unhealthy).toBe(true);
    expect(explicit.snapshot.thresholdMinutes).toBe(45);
    expect(explicit.snapshot.thresholdBasis).toBe("configured");
    const weekly: FlowHistoryBucket[] = [4, 3, 2, 1, 0].map(weeks => [last - weeks * 7 * DAY, last - weeks * 7 * DAY]);
    expect(sourceSilenceObservation(source, { ...activity, history: weekly }, last + 8 * DAY)?.snapshot.thresholdMinutes).toBe(10080);
  });

  it("handles unsorted and string-valued database timestamps without using future receipts", () => {
    const last = monday + (17 * 60 - 1) * MINUTE;
    const history = businessHours(last);
    const expected = historicalGapAllowance(history, last);
    const encoded = history.map(([first, end]): FlowHistoryBucket => [String(first), String(end)]).reverse();
    encoded.push([last + DAY, last + DAY], ["invalid", "invalid"]);
    expect(historicalGapAllowance(encoded, last)).toBe(expected);
  });
});
