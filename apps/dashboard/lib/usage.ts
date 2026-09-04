import "server-only";
import { unstable_cache } from "next/cache";
import { cache } from "react";
import { sanitizeDeliveryAttemptResponseForStorage } from "@axel/shared";
import type { ClickhouseQueryable } from "./clickhouse";
import { clickhouse, hasClickhouseUrl } from "./clickhouse";
import {
  SUCCESS_PREDICATE,
  TERMINAL_FAILURE_PREDICATE,
  latestOutcomesCTE,
} from "./clickhouse-fragments";
import { cacheTags, workspaceCacheScope } from "./repositories";
import { addDaysToDateKey, localDateKey, normalizeWorkspaceTimezone } from "./timezones";
import { publicDeliveryErrorCode } from "./public-delivery-response";

/**
 * Usage data is sourced from ClickHouse and aggregates ingest events / delivery
 * attempts. Cached paths use a short revalidate window for normal dashboard
 * traffic and a workspace metrics tag so destructive data wipes can clear
 * stale rollups immediately.
 */
const USAGE_REVALIDATE_SECONDS = 60;

export interface WorkspaceUsageSummary {
  /** ISO date for the start of the current billing window (UTC, first of month). */
  windowStart: string;
  /** ISO date for the end of the current billing window (next month UTC, exclusive). */
  windowEnd: string;
  /** Events accepted at the ingest edge in the current month. */
  eventsThisMonth: number;
  /** Events accepted in the previous calendar month, for trend comparison. */
  eventsPreviousMonth: number;
  /** Events accepted in the last 24 hours (rolling). */
  eventsLast24h: number;
  /** Total bytes received at the edge in the current month. */
  bytesThisMonth: number;
  /** Total delivery attempts (success + retry + dead) in the current month. */
  deliveryAttemptsThisMonth: number;
  /** Successful deliveries in the current month. */
  deliveriesSucceededThisMonth: number;
  /** Delivery attempts that resulted in a retry being scheduled. */
  retriesThisMonth: number;
  /** Delivery attempts that exceeded the retry policy (terminal failure). */
  deadDeliveriesThisMonth: number;
}

export interface SourceUsageRow {
  source_id: string;
  events: number;
  bytes: number;
}

export interface DailyUsageRow {
  /** Workspace-local day, ISO date `YYYY-MM-DD`. */
  day: string;
  events: number;
  bytes: number;
}

export interface FailureTypeRow {
  /** Human-readable failure type, derived from response_json.error / HTTP status / status. */
  error_type: string;
  count: number;
}

const ROW_CAST = {
  toNumber(input: unknown): number {
    if (typeof input === "number") return input;
    if (typeof input === "string" && input.trim() !== "") {
      const value = Number(input);
      return Number.isFinite(value) ? value : 0;
    }
    return 0;
  },
};

function monthBoundaries(now: Date = new Date()): { start: string; end: string; prevStart: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return {
    start: start.toISOString(),
    end: end.toISOString(),
    prevStart: prevStart.toISOString(),
  };
}

export interface UsageDeps {
  clickhouse?: ClickhouseQueryable;
  now?: () => Date;
  timezone?: string;
}

interface CountRow {
  c: string | number;
  s?: string | number;
}

interface EventTotalsRow {
  events: string | number;
  bytes: string | number;
}

interface DeliveryTotalsRow {
  attempts: string | number;
  success: string | number;
  retries: string | number;
  dead: string | number;
}

async function queryWithRollupFallback<T>(
  rollup: () => Promise<{ rows: T[] }>,
  raw: () => Promise<{ rows: T[] }>,
): Promise<{ rows: T[] }> {
  try {
    return await rollup();
  } catch (err) {
    if (!isMissingClickhouseRollup(err)) throw err;
    return raw();
  }
}

function isMissingClickhouseRollup(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /UNKNOWN_TABLE|does(?:\s+not|n't)\s+exist|Unknown table|Table .* not found/i.test(message);
}

// --- Canonical latest-outcome queries -------------------------------------- //
//
// The three outcome surfaces below (month summary, failure-type breakdown,
// daily delivery chart) share one definition of "the outcome of a delivery",
// composed from lib/clickhouse-fragments. Each helper takes the CTE produced
// by latestOutcomesCTE, so the rollup and raw-fallback branches of a surface
// differ ONLY in the CTE source and each surface differs ONLY in its outer
// aggregation. See the fragments module for the argMax/pushdown rationale
// (ROL-629) and the replay/already_delivered semantics.

/** Month-summary totals: attempts/success/retries/dead within [start, end). */
function deliveryTotalsSql(cte: string): string {
  return `SELECT
        count(*) AS attempts,
        countIf(${SUCCESS_PREDICATE}) AS success,
        countIf(outcome_status = 'retry') AS retries,
        countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead
       FROM (
         ${cte}
       )
      WHERE outcome_at < parseDateTime64BestEffort({end:String}, 3)`;
}

/** Unresolved outcomes grouped by response payload + status within [start, end). */
function failureTypesSql(cte: string): string {
  return `SELECT outcome_response AS response_json, outcome_status AS status, count(*) AS c
       FROM (
         ${cte}
       )
      WHERE NOT ${SUCCESS_PREDICATE}
        AND outcome_at < parseDateTime64BestEffort({end:String}, 3)
      GROUP BY outcome_response, outcome_status`;
}

/** Per-day outcome counts since {start}; no upper bound, so the pushdown alone is exact. */
function dailyDeliverySql(cte: string): string {
  return `SELECT toString(toDate(outcome_at, {timezone:String})) AS day,
            countIf(${SUCCESS_PREDICATE}) AS success,
            countIf(outcome_status = 'retry') AS retry,
            countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead
       FROM (
         ${cte}
       )
      GROUP BY day
      ORDER BY day ASC`;
}

/**
 * Compute the current-month usage summary for a single workspace.
 *
 * The query touches three ClickHouse tables (events / delivery_attempts) but
 * each lookup is a partition-pruned scan because the schema is partitioned by
 * day and ordered by (workspace_id, time, ...).
 */
export async function getWorkspaceUsage(
  workspaceId: string,
  deps: UsageDeps = {},
): Promise<WorkspaceUsageSummary> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const bounds = monthBoundaries(now);
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const [eventsCurrent, eventsPrevious, eventsRolling, deliveries] = await Promise.all([
    queryWithRollupFallback<EventTotalsRow>(
      () => ch.query<EventTotalsRow>(
        `SELECT uniqExactMerge(events) AS events, sum(bytes) AS bytes
           FROM events_daily
          WHERE workspace_id = {workspace_id:String}
            AND day >= toDate(parseDateTime64BestEffort({start:String}, 3))
            AND day <  toDate(parseDateTime64BestEffort({end:String}, 3))`,
        { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
      ),
      () => ch.query<EventTotalsRow>(
      `SELECT uniqExact(event_id) AS events, sum(size_bytes) AS bytes
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND received_at >= parseDateTime64BestEffort({start:String}, 3)
          AND received_at <  parseDateTime64BestEffort({end:String}, 3)`,
        { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
      ),
    ),
    queryWithRollupFallback<CountRow>(
      () => ch.query<CountRow>(
        `SELECT uniqExactMerge(events) AS c
           FROM events_daily
          WHERE workspace_id = {workspace_id:String}
            AND day >= toDate(parseDateTime64BestEffort({start:String}, 3))
            AND day <  toDate(parseDateTime64BestEffort({end:String}, 3))`,
        { workspace_id: workspaceId, start: bounds.prevStart, end: bounds.start },
      ),
      () => ch.query<CountRow>(
      `SELECT uniqExact(event_id) AS c
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND received_at >= parseDateTime64BestEffort({start:String}, 3)
          AND received_at <  parseDateTime64BestEffort({end:String}, 3)`,
        { workspace_id: workspaceId, start: bounds.prevStart, end: bounds.start },
      ),
    ),
    queryWithRollupFallback<CountRow>(
      () => ch.query<CountRow>(
        `SELECT uniqExactMerge(events) AS c
           FROM events_daily
          WHERE workspace_id = {workspace_id:String}
            AND day >= toDate(parseDateTime64BestEffort({start:String}, 3))`,
        { workspace_id: workspaceId, start: last24h },
      ),
      () => ch.query<CountRow>(
      `SELECT uniqExact(event_id) AS c
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND received_at >= parseDateTime64BestEffort({start:String}, 3)`,
        { workspace_id: workspaceId, start: last24h },
      ),
    ),
    queryWithRollupFallback<DeliveryTotalsRow>(
      () => ch.query<DeliveryTotalsRow>(
        deliveryTotalsSql(latestOutcomesCTE({ source: "rollup" })),
        { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
      ),
      () => ch.query<DeliveryTotalsRow>(
        deliveryTotalsSql(latestOutcomesCTE({ source: "attempts" })),
        { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
      ),
    ),
  ]);

  const ev = eventsCurrent.rows[0] ?? { events: 0, bytes: 0 };
  const dl = deliveries.rows[0] ?? { attempts: 0, success: 0, retries: 0, dead: 0 };

  return {
    windowStart: bounds.start,
    windowEnd: bounds.end,
    eventsThisMonth: ROW_CAST.toNumber(ev.events),
    eventsPreviousMonth: ROW_CAST.toNumber(eventsPrevious.rows[0]?.c),
    eventsLast24h: ROW_CAST.toNumber(eventsRolling.rows[0]?.c),
    bytesThisMonth: ROW_CAST.toNumber(ev.bytes),
    deliveryAttemptsThisMonth: ROW_CAST.toNumber(dl.attempts),
    deliveriesSucceededThisMonth: ROW_CAST.toNumber(dl.success),
    retriesThisMonth: ROW_CAST.toNumber(dl.retries),
    deadDeliveriesThisMonth: ROW_CAST.toNumber(dl.dead),
  };
}

/** Top sources by event volume in the current month. */
export async function listSourceUsage(
  workspaceId: string,
  deps: UsageDeps = {},
): Promise<SourceUsageRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const bounds = monthBoundaries(now);

  const result = await queryWithRollupFallback<{ source_id: string; events: string | number; bytes: string | number }>(
    () => ch.query<{ source_id: string; events: string | number; bytes: string | number }>(
      `SELECT source_id,
              uniqExactMerge(events) AS events,
              sum(bytes) AS bytes
         FROM events_daily
        WHERE workspace_id = {workspace_id:String}
          AND day >= toDate(parseDateTime64BestEffort({start:String}, 3))
          AND day <  toDate(parseDateTime64BestEffort({end:String}, 3))
        GROUP BY source_id
        ORDER BY events DESC
        LIMIT 10`,
      { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
    ),
    () => ch.query<{ source_id: string; events: string | number; bytes: string | number }>(
    `SELECT source_id,
            uniqExact(event_id) AS events,
            sum(size_bytes) AS bytes
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND received_at >= parseDateTime64BestEffort({start:String}, 3)
        AND received_at <  parseDateTime64BestEffort({end:String}, 3)
      GROUP BY source_id
      ORDER BY events DESC
      LIMIT 10`,
      { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
    ),
  );

  return result.rows.map((row) => ({
    source_id: row.source_id,
    events: ROW_CAST.toNumber(row.events),
    bytes: ROW_CAST.toNumber(row.bytes),
  }));
}

/** Current-month unresolved delivery outcomes grouped by latest error type. */
export async function listWorkspaceFailureTypes(
  workspaceId: string,
  deps: UsageDeps = {},
): Promise<FailureTypeRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const bounds = monthBoundaries(now);

  const result = await queryWithRollupFallback<{
    response_json: string;
    status: "retry" | "dead";
    c: string | number;
  }>(
    () => ch.query<{
      response_json: string;
      status: "retry" | "dead";
      c: string | number;
    }>(
      failureTypesSql(latestOutcomesCTE({ source: "rollup" })),
      { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
    ),
    () => ch.query<{
      response_json: string;
      status: "retry" | "dead";
      c: string | number;
    }>(
      failureTypesSql(latestOutcomesCTE({ source: "attempts" })),
      { workspace_id: workspaceId, start: bounds.start, end: bounds.end },
    ),
  );

  const totals = new Map<string, number>();
  for (const row of result.rows) {
    const type = failureTypeFromResponse(safeParseJson<Record<string, unknown>>(row.response_json) ?? {}, row.status);
    if (type === "already delivered") continue;
    totals.set(type, (totals.get(type) ?? 0) + ROW_CAST.toNumber(row.c));
  }

  return Array.from(totals.entries())
    .map(([error_type, count]) => ({ error_type, count }))
    .sort((a, b) => b.count - a.count);
}

export interface SourceEventRow {
  event_id: string;
  received_at: string;
  content_type: string;
  size_bytes: number;
  shard: number;
  r2_key: string;
}

export interface SourceEventStats {
  total_events: number;
  events_24h: number;
  bytes_total: number;
  first_seen: string | null;
  last_seen: string | null;
}

/**
 * Most recent N events received by a single source. Powers the per-source
 * detail page. Returns an empty array if ClickHouse hasn't seen anything for
 * this source — the page degrades to an empty state.
 */
export async function listSourceEvents(
  workspaceId: string,
  sourceId: string,
  limit = 50,
  deps: UsageDeps = {},
): Promise<SourceEventRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const result = await ch.query<{
    event_id: string;
    received_at: string;
    content_type: string;
    size_bytes: string | number;
    shard: string | number;
    r2_key: string;
  }>(
    `SELECT event_id,
            toString(received_at) AS received_at,
            content_type,
            size_bytes,
            shard,
            r2_key
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND source_id = {source_id:String}
      ORDER BY received_at DESC
      LIMIT {limit:UInt32}`,
    { workspace_id: workspaceId, source_id: sourceId, limit },
  );
  return result.rows.map((row) => ({
    event_id: row.event_id,
    received_at: row.received_at,
    content_type: row.content_type,
    size_bytes: ROW_CAST.toNumber(row.size_bytes),
    shard: ROW_CAST.toNumber(row.shard),
    r2_key: row.r2_key,
  }));
}

export interface WorkspaceEventRow extends SourceEventRow {
  source_id: string;
}

export interface WorkspaceEventQueryOptions {
  /** Page size. Callers keep this bounded — this is a UI read, never a scan. */
  limit?: number;
  /** Restrict to a single source. */
  sourceId?: string;
  /** Restrict to a single content type. */
  contentType?: string;
  /** Case-insensitive substring match over event id / source id / content type. */
  search?: string;
  /**
   * Keyset cursor: only return events strictly older than this
   * `(received_at, event_id)` position. `receivedAt` accepts both ISO and
   * ClickHouse-native timestamps (parsed with `parseDateTime64BestEffort`).
   * `eventId` breaks ties between events sharing a timestamp; without it the
   * cursor falls back to a plain `received_at <` comparison.
   */
  before?: { receivedAt: string; eventId?: string };
}

/**
 * One page of events across the whole workspace, newest first. Powers the
 * /events panel — the inbound counterpart to /deliveries. Unlike
 * {@link listSourceEvents} this spans every source, so each row carries its
 * own `source_id` for linking back to the source and filtering. Filters and
 * the pagination cursor are pushed into the ClickHouse query as bound
 * parameters, so search spans the full retention window rather than whatever
 * page happens to be loaded. Returns an empty array when ClickHouse is
 * unconfigured or has seen nothing yet — the page degrades to an empty state.
 */
export async function listWorkspaceEvents(
  workspaceId: string,
  options: WorkspaceEventQueryOptions = {},
  deps: UsageDeps = {},
): Promise<WorkspaceEventRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const conditions = ["workspace_id = {workspace_id:String}"];
  const params: Record<string, string | number> = {
    workspace_id: workspaceId,
    limit: options.limit ?? 100,
  };
  if (options.sourceId) {
    conditions.push("source_id = {source_id:String}");
    params.source_id = options.sourceId;
  }
  if (options.contentType) {
    conditions.push("content_type = {content_type:String}");
    params.content_type = options.contentType;
  }
  if (options.search) {
    conditions.push(
      "positionCaseInsensitive(concatWithSeparator(' ', event_id, source_id, content_type), {q:String}) > 0",
    );
    params.q = options.search;
  }
  if (options.before) {
    params.before_received_at = options.before.receivedAt;
    if (options.before.eventId) {
      conditions.push(
        "(received_at, event_id) < (parseDateTime64BestEffort({before_received_at:String}, 3), {before_event_id:String})",
      );
      params.before_event_id = options.before.eventId;
    } else {
      conditions.push("received_at < parseDateTime64BestEffort({before_received_at:String}, 3)");
    }
  }
  const result = await ch.query<{
    event_id: string;
    source_id: string;
    received_at: string;
    content_type: string;
    size_bytes: string | number;
    shard: string | number;
    r2_key: string;
  }>(
    `SELECT event_id,
            source_id,
            toString(received_at) AS received_at,
            content_type,
            size_bytes,
            shard,
            r2_key
       FROM events
      WHERE ${conditions.join("\n        AND ")}
      ORDER BY received_at DESC, event_id DESC
      LIMIT {limit:UInt32}`,
    params,
  );
  return result.rows.map((row) => ({
    event_id: row.event_id,
    source_id: row.source_id,
    received_at: row.received_at,
    content_type: row.content_type,
    size_bytes: ROW_CAST.toNumber(row.size_bytes),
    shard: ROW_CAST.toNumber(row.shard),
    r2_key: row.r2_key,
  }));
}

export interface WorkspaceEventFacets {
  sourceIds: string[];
  contentTypes: string[];
}

/**
 * Distinct source ids and content types across the whole retention window.
 * Powers the /events filter dropdowns so the options reflect everything the
 * workspace has actually received — not just whatever page of rows is
 * currently loaded. Cardinality is bounded by #sources × #content-types, so
 * the LIMIT is a safety valve rather than pagination.
 */
export async function listWorkspaceEventFacets(
  workspaceId: string,
  deps: UsageDeps = {},
): Promise<WorkspaceEventFacets> {
  const ch = deps.clickhouse ?? clickhouse();
  const result = await ch.query<{ source_id: string; content_type: string }>(
    `SELECT DISTINCT source_id, content_type
       FROM events
      WHERE workspace_id = {workspace_id:String}
      LIMIT 1000`,
    { workspace_id: workspaceId },
  );
  const sourceIds = new Set<string>();
  const contentTypes = new Set<string>();
  for (const row of result.rows) {
    if (row.source_id) sourceIds.add(row.source_id);
    if (row.content_type) contentTypes.add(row.content_type);
  }
  return {
    sourceIds: Array.from(sourceIds).sort((a, b) => a.localeCompare(b)),
    contentTypes: Array.from(contentTypes).sort((a, b) => a.localeCompare(b)),
  };
}

/** Aggregate stats for a single source: total, last-24h, byte total, first/last seen. */
export async function getSourceEventStats(
  workspaceId: string,
  sourceId: string,
  deps: UsageDeps = {},
): Promise<SourceEventStats> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // ClickHouse's `toDateTime64('…Z', 3)` rejects the ISO `Z` suffix; we use
  // `parseDateTime64BestEffort` which accepts both the ISO format we get
  // from `Date.toISOString()` AND ClickHouse's native space-separated form,
  // so we don't have to re-format on the JS side.
  const result = await ch.query<{
    total: string | number;
    last_24h: string | number;
    bytes: string | number;
    first_seen: string | null;
    last_seen: string | null;
  }>(
    `SELECT uniqExact(event_id) AS total,
            uniqExactIf(event_id, received_at >= parseDateTime64BestEffort({since:String}, 3)) AS last_24h,
            sum(size_bytes) AS bytes,
            toString(min(received_at)) AS first_seen,
            toString(max(received_at)) AS last_seen
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND source_id = {source_id:String}`,
    { workspace_id: workspaceId, source_id: sourceId, since: last24h },
  );
  const row = result.rows[0];
  return {
    total_events: ROW_CAST.toNumber(row?.total),
    events_24h: ROW_CAST.toNumber(row?.last_24h),
    bytes_total: ROW_CAST.toNumber(row?.bytes),
    first_seen: row?.first_seen && row.first_seen !== "1970-01-01 00:00:00.000" ? row.first_seen : null,
    last_seen: row?.last_seen && row.last_seen !== "1970-01-01 00:00:00.000" ? row.last_seen : null,
  };
}

/**
 * Daily series over the last `days` days (default 30).
 *
 * Reads from the `events_daily` rollup so the dashboard KPI doesn't scan the
 * raw events table on every workspace load. Falls back to the raw `events`
 * table only when the rollup MV isn't deployed (fresh ClickHouse cluster).
 *
 * The rollup buckets by UTC day, so per-day counts can shift by up to one day
 * on the boundary for non-UTC workspaces — 14-/28-day totals are unaffected.
 * The raw fallback still respects workspace timezone.
 */
export async function getDailyUsage(
  workspaceId: string,
  days = 30,
  deps: UsageDeps = {},
): Promise<DailyUsageRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const timezone = normalizeWorkspaceTimezone(deps.timezone);
  const now = deps.now?.() ?? new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await queryWithRollupFallback<{ day: string; events: string | number; bytes: string | number }>(
    () => ch.query<{ day: string; events: string | number; bytes: string | number }>(
      `SELECT day,
              uniqExactMerge(events) AS events,
              sum(bytes) AS bytes
         FROM events_daily
        WHERE workspace_id = {workspace_id:String}
          AND day >= toDate(parseDateTime64BestEffort({start:String}, 3))
        GROUP BY day
        ORDER BY day ASC`,
      { workspace_id: workspaceId, start },
    ),
    () => ch.query<{ day: string; events: string | number; bytes: string | number }>(
      `SELECT toString(toDate(received_at, {timezone:String})) AS day,
              uniqExact(event_id) AS events,
              sum(size_bytes) AS bytes
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND received_at >= parseDateTime64BestEffort({start:String}, 3)
        GROUP BY day
        ORDER BY day ASC`,
      { workspace_id: workspaceId, start, timezone },
    ),
  );

  return result.rows.map((row) => ({
    day: row.day,
    events: ROW_CAST.toNumber(row.events),
    bytes: ROW_CAST.toNumber(row.bytes),
  }));
}

/**
 * Daily event series over the last `days` days for a single source.
 *
 * Same rollup-first strategy as `getDailyUsage`: `events_daily` is keyed on
 * `(workspace_id, day, source_id)`, so a per-source daily series is the
 * narrowest possible scan against the rollup.
 */
export async function getSourceDailyUsage(
  workspaceId: string,
  sourceId: string,
  days = 14,
  deps: UsageDeps = {},
): Promise<DailyUsageRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const timezone = normalizeWorkspaceTimezone(deps.timezone);
  const now = deps.now?.() ?? new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await queryWithRollupFallback<{ day: string; events: string | number; bytes: string | number }>(
    () => ch.query<{ day: string; events: string | number; bytes: string | number }>(
      `SELECT day,
              uniqExactMerge(events) AS events,
              sum(bytes) AS bytes
         FROM events_daily
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND day >= toDate(parseDateTime64BestEffort({start:String}, 3))
        GROUP BY day
        ORDER BY day ASC`,
      { workspace_id: workspaceId, source_id: sourceId, start },
    ),
    () => ch.query<{ day: string; events: string | number; bytes: string | number }>(
      `SELECT toString(toDate(received_at, {timezone:String})) AS day,
              uniqExact(event_id) AS events,
              sum(size_bytes) AS bytes
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND received_at >= parseDateTime64BestEffort({start:String}, 3)
        GROUP BY day
        ORDER BY day ASC`,
      { workspace_id: workspaceId, source_id: sourceId, start, timezone },
    ),
  );

  return result.rows.map((row) => ({
    day: row.day,
    events: ROW_CAST.toNumber(row.events),
    bytes: ROW_CAST.toNumber(row.bytes),
  }));
}

/** Whether the dashboard is configured to query ClickHouse. */
export function usageEnabled(): boolean {
  return hasClickhouseUrl();
}

export interface DailyDeliveryRow {
  /** Workspace-local day, ISO date `YYYY-MM-DD`. */
  day: string;
  success: number;
  retry: number;
  dead: number;
}

/**
 * Per-day latest delivery outcome counts for the dashboard chart.
 *
 * Mirrors getDailyUsage but on the delivery_attempts table. We pivot the
 * status column into three columns at the SQL layer (countIf is cheap on
 * ClickHouse) so the renderer just consumes a flat per-day array.
 *
 * Returns empty if the workspace has no recent delivery attempts — the
 * chart component renders an empty-state in that case rather than 500.
 */
export async function getDailyDeliveryStats(
  workspaceId: string,
  days = 14,
  deps: UsageDeps = {},
): Promise<DailyDeliveryRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const timezone = normalizeWorkspaceTimezone(deps.timezone);
  const now = deps.now?.() ?? new Date();
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await queryWithRollupFallback<{
    day: string;
    success: string | number;
    retry: string | number;
    dead: string | number;
  }>(
    () => ch.query<{
      day: string;
      success: string | number;
      retry: string | number;
      dead: string | number;
    }>(
      // This is the overview page's hottest ClickHouse query — see
      // lib/clickhouse-fragments for the argMax-over-FINAL rationale (ROL-629).
      dailyDeliverySql(latestOutcomesCTE({ source: "rollup" })),
      { workspace_id: workspaceId, start, timezone },
    ),
    () => ch.query<{
      day: string;
      success: string | number;
      retry: string | number;
      dead: string | number;
    }>(
      dailyDeliverySql(latestOutcomesCTE({ source: "attempts" })),
      { workspace_id: workspaceId, start, timezone },
    ),
  );

  return result.rows.map((row) => ({
    day: row.day,
    success: ROW_CAST.toNumber(row.success),
    retry: ROW_CAST.toNumber(row.retry),
    dead: ROW_CAST.toNumber(row.dead),
  }));
}

/**
 * Densify a sparse per-day series so the chart shows a contiguous timeline
 * (zero bars for days where nothing happened) rather than auto-collapsing
 * gaps. ClickHouse only returns days that had rows; the chart UX is much
 * clearer with explicit zeros.
 */
export function densifyDailySeries<T extends { day: string }>(
  rows: T[],
  days: number,
  fill: (day: string) => T,
  timezone = "UTC",
  now: Date = new Date(),
): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  const today = localDateKey(now, timezone);
  // Walk back `days - 1` to today (inclusive) so we get exactly `days` entries.
  for (let i = days - 1; i >= 0; i--) {
    const day = addDaysToDateKey(today, -i);
    out.push(byDay.get(day) ?? fill(day));
  }
  return out;
}

// --- Single-event detail (powers /sources/[id]/events/[eventId]) ----------- //

export interface EventDetailRow {
  event_id: string;
  source_id: string;
  workspace_id: string;
  received_at: string;
  content_type: string;
  size_bytes: number;
  shard: number;
  r2_key: string;
  /** Reserved value-free request metadata map. */
  headers: Record<string, string>;
  /** Reserved value-free query metadata map. */
  query: Record<string, string>;
}

/**
 * Look up one event by id, scoped to the workspace. Returns null if the event
 * doesn't exist (404 territory) or if ClickHouse rejected the query.
 *
 * NOTE: ClickHouse's `events` table has a 30-day TTL, so events older than
 * that won't be findable here even though their R2 payload may still exist.
 */
export async function getEventDetail(
  workspaceId: string,
  eventId: string,
  deps: UsageDeps = {},
): Promise<EventDetailRow | null> {
  const ch = deps.clickhouse ?? clickhouse();
  const result = await ch.query<{
    event_id: string;
    source_id: string;
    workspace_id: string;
    received_at: string;
    content_type: string;
    size_bytes: string | number;
    shard: string | number;
    r2_key: string;
  }>(
    `SELECT event_id, source_id, workspace_id,
            toString(received_at) AS received_at,
            content_type, size_bytes, shard, r2_key
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND event_id = {event_id:String}
      LIMIT 1`,
    { workspace_id: workspaceId, event_id: eventId },
  );
  const row = result.rows[0];
  if (!row) return null;

  return {
    event_id: row.event_id,
    source_id: row.source_id,
    workspace_id: row.workspace_id,
    received_at: row.received_at,
    content_type: row.content_type,
    size_bytes: ROW_CAST.toNumber(row.size_bytes),
    shard: ROW_CAST.toNumber(row.shard),
    r2_key: row.r2_key,
    headers: {},
    query: {},
  };
}

export interface DeliveryAttemptRow {
  attempt_id: string;
  route_id: string;
  destination_id: string;
  attempt_no: number;
  status: "success" | "retry" | "dead";
  latency_ms: number;
  /** Parsed response_json — connector type, http_status, error, etc. */
  response: {
    destination_type?: string;
    http_status?: number;
    error?: string;
  } & Record<string, unknown>;
  created_at: string;
}

export type DeliveryAttemptStatus = DeliveryAttemptRow["status"];

export interface WorkspaceDeliveryAttemptRow extends DeliveryAttemptRow {
  event_id: string;
  source_id: string | null;
}

/**
 * Every delivery attempt logged for a single event, ordered chronologically.
 *
 * Each (route_id, destination_id) pair may have MULTIPLE rows here — one per
 * attempt_no. The page renders them grouped so an operator can see "this
 * destination was retried three times before succeeding".
 *
 * Returns [] if the dashboard isn't configured for ClickHouse, or if no rows
 * exist (e.g. delivery hasn't logged yet for new events).
 */
export async function listDeliveryAttemptsForEvent(
  workspaceId: string,
  eventId: string,
  deps: UsageDeps = {},
): Promise<DeliveryAttemptRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const result = await ch.query<{
    attempt_id: string;
    route_id: string;
    destination_id: string;
    attempt_no: string | number;
    status: "success" | "retry" | "dead";
    latency_ms: string | number;
    response_json: string;
    created_at: string;
  }>(
    `SELECT attempt_id,
            route_id,
            destination_id,
            attempt_no,
            status,
            latency_ms,
            response_json,
            toString(created_at) AS created_at
       FROM delivery_attempts
      WHERE workspace_id = {workspace_id:String}
        AND event_id = {event_id:String}
      ORDER BY created_at ASC, attempt_no ASC`,
    { workspace_id: workspaceId, event_id: eventId },
  );
  return result.rows.map((row) => ({
    attempt_id: row.attempt_id,
    route_id: row.route_id,
    destination_id: row.destination_id,
    attempt_no: ROW_CAST.toNumber(row.attempt_no),
    status: row.status,
    latency_ms: ROW_CAST.toNumber(row.latency_ms),
    response: safeDeliveryAttemptResponse(row.response_json),
    created_at: row.created_at,
  }));
}

/**
 * Most recent delivery attempts for the whole workspace. Used by /deliveries
 * to show normal successes alongside retries and terminal failures.
 */
export async function listWorkspaceDeliveryAttempts(
  workspaceId: string,
  status: DeliveryAttemptStatus | null = null,
  limit = 100,
  deps: UsageDeps = {},
): Promise<WorkspaceDeliveryAttemptRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const statusPredicate = status ? "AND d.status = {status:String}" : "";
  const params: Record<string, string | number> = { workspace_id: workspaceId, limit };
  if (status) params.status = status;

  const result = await ch.query<{
    attempt_id: string;
    event_id: string;
    source_id: string | null;
    route_id: string;
    destination_id: string;
    attempt_no: string | number;
    status: DeliveryAttemptStatus;
    latency_ms: string | number;
    response_json: string;
    created_at: string;
  }>(
    `SELECT d.attempt_id,
            d.event_id,
            CAST(NULL, 'Nullable(String)') AS source_id,
            d.route_id,
            d.destination_id,
            d.attempt_no,
            d.status,
            d.latency_ms,
            d.response_json,
            toString(d.created_at) AS created_at
       FROM delivery_attempts d
      WHERE d.workspace_id = {workspace_id:String}
        ${statusPredicate}
      ORDER BY d.created_at DESC
      LIMIT {limit:UInt32}`,
    params,
  );

  return result.rows.map((row) => ({
    attempt_id: row.attempt_id,
    event_id: row.event_id,
    source_id: row.source_id,
    route_id: row.route_id,
    destination_id: row.destination_id,
    attempt_no: ROW_CAST.toNumber(row.attempt_no),
    status: row.status,
    latency_ms: ROW_CAST.toNumber(row.latency_ms),
    response: safeDeliveryAttemptResponse(row.response_json),
    created_at: row.created_at,
  }));
}

function safeParseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function safeDeliveryAttemptResponse(raw: string | null | undefined): DeliveryAttemptRow["response"] {
  const parsed = sanitizeDeliveryAttemptResponseForStorage(
    safeParseJson<DeliveryAttemptRow["response"]>(raw) ?? {},
  ) as DeliveryAttemptRow["response"];
  const response: DeliveryAttemptRow["response"] = {};
  if (typeof parsed.destination_type === "string" && /^[a-z][a-z0-9_]{0,31}$/.test(parsed.destination_type)) {
    response.destination_type = parsed.destination_type;
  }
  if (
    typeof parsed.http_status === "number" &&
    Number.isInteger(parsed.http_status) &&
    parsed.http_status >= 100 &&
    parsed.http_status <= 599
  ) {
    response.http_status = parsed.http_status;
  }
  if (typeof parsed.error === "string" && parsed.error.trim()) {
    response.error = publicDeliveryErrorCode(parsed.error) ?? "delivery_failed";
  }
  return response;
}

// --- Per-route delivery stats (powers the routes canvas) ------------------- //

export interface RouteDeliveryStats {
  route_id: string;
  destination_id: string;
  /** Successful deliveries in the last 24h. */
  success: number;
  /** Retries in flight or completed in the last 24h. */
  retry: number;
  /** Terminal failures in the last 24h. */
  dead: number;
  /** Unix-ms timestamp of the most recent attempt, or null if none. */
  last_attempt_at: string | null;
}

/**
 * Last-24h delivery stats grouped by (route_id, destination_id) — feeds the
 * route canvas's edge color/health indicator. Zero rows means "no recent
 * activity" which the canvas renders as a gray edge.
 */
export async function getRouteDeliveryStats24h(
  workspaceId: string,
  deps: UsageDeps = {},
): Promise<RouteDeliveryStats[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  const result = await ch.query<{
    route_id: string;
    destination_id: string;
    success: string | number;
    retry: string | number;
    dead: string | number;
    last_attempt_at: string | null;
  }>(
    `SELECT route_id,
            destination_id,
            countIf(status = 'success') AS success,
            countIf(status = 'retry')   AS retry,
            countIf(status = 'dead')    AS dead,
            toString(max(created_at))   AS last_attempt_at
       FROM delivery_attempts
      WHERE workspace_id = {workspace_id:String}
        AND created_at >= parseDateTime64BestEffort({since:String}, 3)
      GROUP BY route_id, destination_id`,
    { workspace_id: workspaceId, since },
  );
  return result.rows.map((row) => ({
    route_id: row.route_id,
    destination_id: row.destination_id,
    success: ROW_CAST.toNumber(row.success),
    retry: ROW_CAST.toNumber(row.retry),
    dead: ROW_CAST.toNumber(row.dead),
    last_attempt_at: row.last_attempt_at && row.last_attempt_at !== "1970-01-01 00:00:00.000"
      ? row.last_attempt_at
      : null,
  }));
}

export interface RouteEventRow {
  event_id: string;
  source_id: string;
  received_at: string;
  /** Map of destination_id → most recent status (success / retry / dead). */
  delivery_status_by_destination: Record<string, "success" | "retry" | "dead">;
  /** Most recent attempt across destinations — used to sort. */
  last_attempt_at: string | null;
  size_bytes: number;
}

/**
 * Recent events that flowed through a single route. Powers the "logging
 * popup" on the route detail page.
 *
 * Strategy:
 *   - Find delivery_attempts for this route in the last 24h, group by event.
 *   - For each event, take the latest status per destination.
 *   - Join with the events table to pull received_at + size_bytes.
 *
 * Returns empty when delivery_attempts has nothing — typical for new routes,
 * routes that disabled, or events received before logging was wired up.
 */
export async function listRecentRouteEvents(
  workspaceId: string,
  routeId: string,
  limit = 50,
  deps: UsageDeps = {},
): Promise<RouteEventRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const result = await ch.query<{
    event_id: string;
    source_id: string;
    received_at: string;
    size_bytes: string | number;
    statuses_pack: string; // a string like "dst1:success,dst2:retry"
    last_attempt_at: string | null;
  }>(
    `WITH recent_events AS (
        SELECT event_id,
               max(created_at) AS last_attempt_at
          FROM delivery_attempts
         WHERE workspace_id = {workspace_id:String}
           AND route_id = {route_id:String}
           AND created_at >= parseDateTime64BestEffort({since:String}, 3)
         GROUP BY event_id
         ORDER BY last_attempt_at DESC
         LIMIT {limit:UInt32}
      ),
      latest_destination_attempts AS (
        SELECT d.event_id,
               d.destination_id,
               argMax(d.status, d.created_at) AS status
          FROM delivery_attempts d
          INNER JOIN recent_events r ON r.event_id = d.event_id
         WHERE d.workspace_id = {workspace_id:String}
           AND d.route_id = {route_id:String}
           AND d.created_at >= parseDateTime64BestEffort({since:String}, 3)
         GROUP BY d.event_id, d.destination_id
      )
      SELECT r.event_id AS event_id,
             e.source_id AS source_id,
             toString(e.received_at) AS received_at,
             e.size_bytes AS size_bytes,
             arrayStringConcat(groupArray(concat(a.destination_id, ':', a.status)), ',') AS statuses_pack,
             toString(r.last_attempt_at) AS last_attempt_at
        FROM recent_events r
        LEFT JOIN latest_destination_attempts a ON a.event_id = r.event_id
        LEFT JOIN events e ON e.event_id = r.event_id AND e.workspace_id = {workspace_id:String}
       GROUP BY r.event_id, r.last_attempt_at, e.source_id, e.received_at, e.size_bytes
       ORDER BY r.last_attempt_at DESC`,
    { workspace_id: workspaceId, route_id: routeId, since, limit },
  );
  return result.rows.map((row) => {
    const status_map: Record<string, "success" | "retry" | "dead"> = {};
    if (row.statuses_pack) {
      for (const pair of row.statuses_pack.split(",")) {
        const [dest, status] = pair.split(":");
        if (dest && (status === "success" || status === "retry" || status === "dead")) {
          status_map[dest] = status;
        }
      }
    }
    return {
      event_id: row.event_id,
      source_id: row.source_id,
      received_at: row.received_at,
      delivery_status_by_destination: status_map,
      last_attempt_at: row.last_attempt_at,
      size_bytes: ROW_CAST.toNumber(row.size_bytes),
    };
  });
}

export interface SourceEventCounts {
  source_id: string;
  events_24h: number;
  events_30d: number;
  events_all: number;
}

/**
 * Per-source event counts across 24h, 30d, and all-time windows in one query.
 *
 * NOTE: the events table has a 30-day TTL, so "all time" is effectively bounded
 * by retention. We still emit it as a separate column so the UI is honest about
 * what's being counted and so a future retention bump doesn't require a code
 * change here.
 */
export async function getSourceEventCountsByWindow(
  workspaceId: string,
  deps: UsageDeps = {},
): Promise<SourceEventCounts[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const result = await ch.query<{
    source_id: string;
    events_24h: string | number;
    events_30d: string | number;
    events_all: string | number;
  }>(
    `SELECT source_id,
            uniqExactIf(event_id, received_at >= parseDateTime64BestEffort({since24h:String}, 3)) AS events_24h,
            uniqExactIf(event_id, received_at >= parseDateTime64BestEffort({since30d:String}, 3)) AS events_30d,
            uniqExact(event_id) AS events_all
       FROM events
      WHERE workspace_id = {workspace_id:String}
      GROUP BY source_id`,
    { workspace_id: workspaceId, since24h, since30d },
  );
  return result.rows.map((row) => ({
    source_id: row.source_id,
    events_24h: ROW_CAST.toNumber(row.events_24h),
    events_30d: ROW_CAST.toNumber(row.events_30d),
    events_all: ROW_CAST.toNumber(row.events_all),
  }));
}

/** Format a byte count for dashboard display. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log10(bytes) / 3), units.length - 1);
  const value = bytes / Math.pow(1000, exponent);
  return `${value >= 100 || exponent === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[exponent]}`;
}

/** Format a count with thousands separators for dashboard display. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US");
}

/**
 * Compact count: 831,099 → "831K", 1,821,476 → "1.82M". Used in KPI
 * cards when the container is too narrow to fit the full thousands-
 * separated value without clipping.
 */
export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Math.abs(value) < 1000) return value.toLocaleString("en-US");
  return value.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  });
}

/** Compute success / failure percentages from a usage summary. */
export function deliveryRates(summary: WorkspaceUsageSummary): {
  success: number;
  failure: number;
  retry: number;
  dead: number;
} {
  const total = summary.deliveryAttemptsThisMonth;
  if (total === 0) return { success: 0, failure: 0, retry: 0, dead: 0 };
  const failure = (summary.retriesThisMonth + summary.deadDeliveriesThisMonth) / total;
  return {
    success: summary.deliveriesSucceededThisMonth / total,
    failure,
    retry: summary.retriesThisMonth / total,
    dead: summary.deadDeliveriesThisMonth / total,
  };
}

function failureTypeFromResponse(
  response: Record<string, unknown>,
  status: "retry" | "dead",
): string {
  const error = response["error"];
  if (typeof error === "string" && error.trim().length > 0) {
    return humanizeFailureType(publicDeliveryErrorCode(error) ?? "delivery_failed");
  }

  const httpStatus = response["http_status"];
  if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) {
    return `HTTP ${httpStatus}`;
  }

  return status === "retry" ? "retry scheduled" : "failed";
}

function humanizeFailureType(value: string): string {
  const normalized = value.trim().replace(/[_-]+/g, " ");
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

// --- Cached read paths ---------------------------------------------------- //
//
// Wrappers for server components that always use the default ClickHouse
// client. Tests call the un-cached versions with their own deps. Each
// wrapper is keyed on workspaceId (and any other args), so navigations and
// the multiple components on /dashboard collapse onto a single CH query.

export const getDailyUsageCached = cache(function getDailyUsageCached(
  workspaceId: string,
  days: number,
  timezone = "UTC",
): Promise<DailyUsageRow[]> {
  const normalizedTimezone = normalizeWorkspaceTimezone(timezone);
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => getDailyUsage(workspaceId, days, { timezone: normalizedTimezone }),
    ["daily-usage", scope, String(days), normalizedTimezone],
    { tags: [cacheTags.metrics(workspaceId)], revalidate: USAGE_REVALIDATE_SECONDS },
  )();
});

export const getDailyDeliveryStatsCached = cache(function getDailyDeliveryStatsCached(
  workspaceId: string,
  days: number,
  timezone = "UTC",
): Promise<DailyDeliveryRow[]> {
  const normalizedTimezone = normalizeWorkspaceTimezone(timezone);
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => getDailyDeliveryStats(workspaceId, days, { timezone: normalizedTimezone }),
    ["daily-delivery", scope, String(days), normalizedTimezone],
    { tags: [cacheTags.metrics(workspaceId)], revalidate: USAGE_REVALIDATE_SECONDS },
  )();
});

export function listSourceUsageCached(workspaceId: string): Promise<SourceUsageRow[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => listSourceUsage(workspaceId),
    ["source-usage", scope],
    { tags: [cacheTags.metrics(workspaceId), cacheTags.sources(workspaceId)], revalidate: USAGE_REVALIDATE_SECONDS },
  )();
}

export function getSourceEventCountsByWindowCached(
  workspaceId: string,
): Promise<SourceEventCounts[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => getSourceEventCountsByWindow(workspaceId),
    ["source-event-counts-windows", scope],
    { tags: [cacheTags.metrics(workspaceId), cacheTags.sources(workspaceId)], revalidate: USAGE_REVALIDATE_SECONDS },
  )();
}
