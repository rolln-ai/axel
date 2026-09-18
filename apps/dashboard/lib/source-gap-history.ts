/** First and last accepted receipts in each occupied 15-minute bucket. */
export type FlowHistoryBucket = [number | string, number | string];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const weekend = (at: number) => [0, 6].includes(new Date(at).getUTCDay());

function retainedBuckets(history: FlowHistoryBucket[], lastReceived: number): (readonly [number, number])[] {
  return history.map(([first, last]) => [Number(first), Number(last)] as const)
    .filter(([first, last]) => Number.isFinite(first) && first > 0 && last >= first
      && last <= lastReceived && first >= lastReceived - 30 * DAY)
    .sort((a, b) => a[0] - b[0]);
}

export interface ObservedGapBaseline {
  /** Earliest retained receipt, or null when nothing has been retained. */
  firstReceived: number | null;
  /** Longest completed quiet period between retained receipts. */
  longestGapMs: number;
}

/**
 * The longest silence this source has already survived. Unlike the recurring
 * pattern below, one long gap counts: a source that has gone quiet for two
 * days before is expected to do so again. The ongoing gap never counts.
 */
export function observedGapBaseline(history: FlowHistoryBucket[], lastReceived: number): ObservedGapBaseline {
  const buckets = retainedBuckets(history, lastReceived);
  let longestGapMs = 0;
  for (let i = 1; i < buckets.length; i++) {
    longestGapMs = Math.max(longestGapMs, buckets[i]![0] - buckets[i - 1]![1]);
  }
  return { firstReceived: buckets[0]?.[0] ?? null, longestGapMs };
}

/**
 * Compare the last receipt's clock time with completed quiet periods on earlier
 * days. Three independent gaps must support an allowance. A single outage,
 * even one spanning several days, cannot count as several examples.
 *
 * Bucket boundaries retain exact receipts for every gap longer than 15 minutes.
 * Unlike an event-count sample, busy bursts cannot crowd nights out of history.
 */
export function historicalGapAllowance(history: FlowHistoryBucket[], lastReceived: number): number {
  const buckets = retainedBuckets(history, lastReceived);
  const firstBucket = buckets[0];
  if (!firstBucket || lastReceived - firstBucket[0] < 7 * DAY) return 0;

  const daily = new Map<number, number>();
  const weekly = new Map<number, number>();
  for (let daysAgo = 1; daysAgo <= 30; daysAgo++) {
    const anchor = lastReceived - daysAgo * DAY;
    if (anchor < firstBucket[0]) break;
    for (let i = 1; i < buckets.length; i++) {
      const start = buckets[i - 1]![1];
      const end = buckets[i]![0];
      // Allow half an hour of schedule jitter. Never use the ongoing gap or
      // invent silence before the first retained event.
      if (start > anchor + 30 * MINUTE || end <= anchor || end - start < 30 * MINUTE) continue;
      const allowance = end - anchor;
      // At most one vote per historical start date, and no multi-day outage
      // votes in the daily pool. Weekly schedules need matching weekdays.
      const date = Math.floor(start / DAY);
      if (daysAgo % 7 === 0) weekly.set(date, Math.max(weekly.get(date) ?? 0, allowance));
      if (weekend(anchor) === weekend(lastReceived) && end - start <= DAY) {
        daily.set(date, Math.max(daily.get(date) ?? 0, allowance));
      }
    }
  }
  const repeated = (gaps: Map<number, number>) => [...gaps.values()].sort((a, b) => b - a)[2] ?? 0;
  // A 25% grace period absorbs ordinary timing variation. The policy applies
  // the same seven-day ceiling as the recent-cadence baseline.
  return Math.max(repeated(daily), repeated(weekly)) * 1.25;
}
