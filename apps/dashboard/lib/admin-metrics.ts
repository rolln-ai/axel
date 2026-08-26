import "server-only";
import { clickhouse, hasClickhouseUrl } from "./clickhouse";

/**
 * Cross-workspace ClickHouse rollups used by the super-admin overview page.
 * Mirrors the per-workspace queries in `lib/usage.ts` but removes the
 * `workspace_id = ...` filter. As with admin-queries.ts, keep these helpers
 * isolated from the workspace-scoped usage module so unscoped queries are
 * grep-obvious.
 */

export interface GlobalEventTotals {
  /** Events accepted at the ingest edge in the trailing 30 days. */
  eventsLast30d: number;
  /** Bytes received in the trailing 30 days. */
  bytesLast30d: number;
  /** Events accepted in the trailing 24 hours. */
  eventsLast24h: number;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export async function getGlobalEventTotals(): Promise<GlobalEventTotals | null> {
  if (!hasClickhouseUrl()) return null;
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const ch = clickhouse();
  const [windowResult, dayResult] = await Promise.all([
    ch.query<{ events: string | number; bytes: string | number }>(
      `SELECT uniqExactMerge(events) AS events, sum(bytes) AS bytes
         FROM events_daily
        WHERE day >= toDate(parseDateTime64BestEffort({start:String}, 3))`,
      { start: thirtyDaysAgo },
    ),
    ch.query<{ c: string | number }>(
      `SELECT uniqExactMerge(events) AS c
         FROM events_daily
        WHERE day >= toDate(parseDateTime64BestEffort({start:String}, 3))`,
      { start: last24h },
    ),
  ]);

  return {
    eventsLast30d: toNumber(windowResult.rows[0]?.events),
    bytesLast30d: toNumber(windowResult.rows[0]?.bytes),
    eventsLast24h: toNumber(dayResult.rows[0]?.c),
  };
}

