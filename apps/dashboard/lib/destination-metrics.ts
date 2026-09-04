import "server-only";
import type { ClickhouseQueryable } from "./clickhouse";
import { clickhouse } from "./clickhouse";
import {
  OUTCOME_SKIP_PREDICATE,
  SKIP_PREDICATE,
  SUCCESS_PREDICATE,
  TERMINAL_FAILURE_PREDICATE,
  latestOutcomesCTE,
} from "./clickhouse-fragments";
import { publicDeliveryErrorCode } from "./public-delivery-response";
import { normalizeWorkspaceTimezone } from "./timezones";

/**
 * Per-destination analytics queries against the ClickHouse delivery_attempts
 * table. All queries are workspace-scoped + destination-scoped and respect the
 * 30-day TTL on the underlying table.
 *
 * Outcome-level metrics (success rate, failure counts, response breakdown)
 * compose the canonical latest-outcome definition from
 * lib/clickhouse-fragments — the same one lib/usage.ts uses for the workspace
 * dashboard — so a destination page and the workspace overview can never
 * disagree about whether a delivery succeeded. Attempt-level surfaces (the
 * recent-attempts log, per-attempt latency) intentionally stay on raw
 * delivery_attempts rows.
 *
 * Mirrors the patterns in lib/usage.ts: parameterised queries, string-or-number
 * row casting (ClickHouse JSON returns big integers as strings), and a
 * pluggable ClickhouseQueryable for testing.
 */

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

export interface MetricsDeps {
  clickhouse?: ClickhouseQueryable;
  now?: () => Date;
  timezone?: string;
}

export interface DeliveryWindowSummary {
  /**
   * Distinct non-test delivery outcomes in the window — one per
   * (base_event_id, route, destination); retries and replays collapse onto
   * the latest attempt (canonical definition, lib/clickhouse-fragments).
   */
  attempts: number;
  /** Outcomes whose latest attempt succeeded (incl. `already_delivered`). */
  success: number;
  /** Outcomes currently in retry from real delivery attempts — skips are counted separately. */
  retry: number;
  /** Terminal failures, excluding `already_delivered`. */
  dead: number;
  /**
   * Outcomes whose latest row was suppressed without contacting the
   * destination (breaker open, operator pause, retry-after window, rate
   * limit). Logged as 0ms "retry" rows; folding them into
   * retry/latency/success-rate made a paused destination read as a slow,
   * failing one (ROL-628).
   */
  skipped: number;
  /** success / (attempts - skipped); fraction in [0, 1], 0 when no real attempts. */
  successRate: number;
  /** Average latency in ms across real, non-terminal attempts in the window (attempt-level). */
  avgLatencyMs: number;
  /** Most recent attempt timestamp (string) or null. */
  lastAttemptAt: string | null;
}

interface DeliveryWindowOutcomeRow {
  attempts: string | number;
  success: string | number;
  retry: string | number;
  dead: string | number;
  skipped: string | number;
}

interface DeliveryWindowAttemptRow {
  avg_latency_ms: string | number | null;
  last_attempt_at: string | null;
}

const ZERO_TS = "1970-01-01 00:00:00.000";

function nullableTs(raw: string | null | undefined): string | null {
  if (!raw || raw === ZERO_TS) return null;
  return raw;
}

function isoSinceHours(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function isoSinceDays(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Aggregate counts + avg latency for a destination over a rolling window.
 * Used for both the 24h and 7d KPI cards.
 */
export async function getDestinationDeliverySummary(
  workspaceId: string,
  destinationId: string,
  windowHours: number,
  deps: MetricsDeps = {},
): Promise<DeliveryWindowSummary> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const start = isoSinceHours(now, windowHours);
  const params = { workspace_id: workspaceId, destination_id: destinationId, start };

  // Test events are excluded (matches backfill/event-diff/route-canvas
  // readers); skips are split out so success rate and latency describe only
  // deliveries that actually reached the destination. Terminal skip rows
  // (budget exhausted while paused) stay in `dead` — they are real outcomes.
  // Counts collapse to latest outcomes (canonical definition); latency and
  // last-attempt stay attempt-level, so the two are queried separately.
  const [outcomeResult, attemptResult] = await Promise.all([
    ch.query<DeliveryWindowOutcomeRow>(
      `SELECT
          count(*) AS attempts,
          countIf(${SUCCESS_PREDICATE}) AS success,
          countIf(outcome_status = 'retry' AND NOT ${OUTCOME_SKIP_PREDICATE}) AS retry,
          countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead,
          countIf(outcome_status = 'retry' AND ${OUTCOME_SKIP_PREDICATE}) AS skipped
         FROM (
           ${latestOutcomesCTE({ source: "attempts", scope: { destination: true, excludeTest: true } })}
         )`,
      params,
    ),
    ch.query<DeliveryWindowAttemptRow>(
      `SELECT
          avgIf(latency_ms, status != 'dead' AND NOT ${SKIP_PREDICATE}) AS avg_latency_ms,
          toString(max(created_at)) AS last_attempt_at
         FROM delivery_attempts
        WHERE workspace_id = {workspace_id:String}
          AND destination_id = {destination_id:String}
          AND created_at >= parseDateTime64BestEffort({start:String}, 3)
          AND is_test = 0`,
      params,
    ),
  ]);
  const outcomes = outcomeResult.rows[0];
  const attemptRow = attemptResult.rows[0];
  const attempts = ROW_CAST.toNumber(outcomes?.attempts);
  const success = ROW_CAST.toNumber(outcomes?.success);
  const skipped = ROW_CAST.toNumber(outcomes?.skipped);
  const realAttempts = attempts - skipped;
  return {
    attempts,
    success,
    retry: ROW_CAST.toNumber(outcomes?.retry),
    dead: ROW_CAST.toNumber(outcomes?.dead),
    skipped,
    successRate: realAttempts > 0 ? success / realAttempts : 0,
    avgLatencyMs: ROW_CAST.toNumber(attemptRow?.avg_latency_ms),
    lastAttemptAt: nullableTs(attemptRow?.last_attempt_at),
  };
}

export interface DailyDestinationDeliveryRow {
  /** Workspace-local day, ISO date `YYYY-MM-DD`. */
  day: string;
  success: number;
  retry: number;
  dead: number;
  /** Median latency for the day, in ms. */
  p50_latency_ms: number;
  /** P95 latency for the day, in ms. */
  p95_latency_ms: number;
}

/**
 * The single most recent delivery-attempt timestamp for a destination, across
 * ALL routes and all time (not windowed). Powers the detail-header
 * "Last delivery" highlight. Returns null when the destination has never had a
 * delivery attempt. `max(created_at)` is cheap on the (workspace, destination)-
 * ordered table; nullableTs maps the empty-set zero timestamp to null.
 */
export async function getDestinationLastDelivery(
  workspaceId: string,
  destinationId: string,
  deps: MetricsDeps = {},
): Promise<{ lastAttemptAt: string | null }> {
  const ch = deps.clickhouse ?? clickhouse();
  // Skips excluded: while a destination is paused, skip rows keep landing
  // with fresh timestamps, and "Last delivery: 0s ago" actively reassured
  // during an outage. This stat means "last time we actually tried".
  const result = await ch.query<{ last_attempt_at: string | null }>(
    `SELECT toString(max(created_at)) AS last_attempt_at
       FROM delivery_attempts
      WHERE workspace_id = {workspace_id:String}
        AND destination_id = {destination_id:String}
        AND NOT ${SKIP_PREDICATE}`,
    { workspace_id: workspaceId, destination_id: destinationId },
  );
  return { lastAttemptAt: nullableTs(result.rows[0]?.last_attempt_at) };
}

/**
 * Per-day delivery outcome counts + latency percentiles for a single
 * destination. Powers the time-series stacked bar chart and the latency
 * sparkline. Counts are latest outcomes per (event, route) — same definition
 * as the workspace daily chart; percentiles are over the final attempt's
 * latency for each outcome, bucketed by the day the outcome landed.
 */
export async function getDailyDestinationDeliveryStats(
  workspaceId: string,
  destinationId: string,
  days = 14,
  deps: MetricsDeps = {},
): Promise<DailyDestinationDeliveryRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const timezone = normalizeWorkspaceTimezone(deps.timezone);
  const now = deps.now?.() ?? new Date();
  const start = isoSinceDays(now, days);

  const result = await ch.query<{
    day: string;
    success: string | number;
    retry: string | number;
    dead: string | number;
    p50_latency_ms: string | number | null;
    p95_latency_ms: string | number | null;
  }>(
    `SELECT toString(toDate(outcome_at, {timezone:String})) AS day,
            countIf(${SUCCESS_PREDICATE}) AS success,
            countIf(outcome_status = 'retry') AS retry,
            countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead,
            quantile(0.5)(outcome_latency_ms)  AS p50_latency_ms,
            quantile(0.95)(outcome_latency_ms) AS p95_latency_ms
       FROM (
         ${latestOutcomesCTE({ source: "attempts", scope: { destination: true } })}
       )
      GROUP BY day
      ORDER BY day ASC`,
    { workspace_id: workspaceId, destination_id: destinationId, start, timezone },
  );

  return result.rows.map((row) => ({
    day: row.day,
    success: ROW_CAST.toNumber(row.success),
    retry: ROW_CAST.toNumber(row.retry),
    dead: ROW_CAST.toNumber(row.dead),
    p50_latency_ms: ROW_CAST.toNumber(row.p50_latency_ms),
    p95_latency_ms: ROW_CAST.toNumber(row.p95_latency_ms),
  }));
}

export interface LatencyPercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  /** Sample size used to compute the percentiles. */
  count: number;
}

/**
 * Latency percentiles for a destination over a rolling window, measured on
 * the final attempt of each delivery outcome. Excludes terminal failures
 * (where latency is the max-retry-budget timeout, not real RT) and skipped
 * outcomes (0ms rows that never contacted the destination — including them
 * made a paused destination read as impossibly fast).
 */
export async function getDestinationLatencyPercentiles(
  workspaceId: string,
  destinationId: string,
  windowHours = 24,
  deps: MetricsDeps = {},
): Promise<LatencyPercentiles> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const start = isoSinceHours(now, windowHours);

  const result = await ch.query<{
    p50: string | number | null;
    p95: string | number | null;
    p99: string | number | null;
    max_latency: string | number | null;
    count: string | number;
  }>(
    `SELECT quantile(0.5)(outcome_latency_ms)   AS p50,
            quantile(0.95)(outcome_latency_ms)  AS p95,
            quantile(0.99)(outcome_latency_ms)  AS p99,
            max(outcome_latency_ms)             AS max_latency,
            count(*)                            AS count
       FROM (
         ${latestOutcomesCTE({ source: "attempts", scope: { destination: true } })}
       )
      WHERE NOT ${TERMINAL_FAILURE_PREDICATE}
        AND NOT ${OUTCOME_SKIP_PREDICATE}`,
    { workspace_id: workspaceId, destination_id: destinationId, start },
  );
  const row = result.rows[0];
  return {
    p50: ROW_CAST.toNumber(row?.p50),
    p95: ROW_CAST.toNumber(row?.p95),
    p99: ROW_CAST.toNumber(row?.p99),
    max: ROW_CAST.toNumber(row?.max_latency),
    count: ROW_CAST.toNumber(row?.count),
  };
}

export interface ResponseCodeBucket {
  /** "200", "404", "timeout", "connector-error", or "unknown". */
  bucket: string;
  count: number;
  /** Whether this bucket should be coloured as success (2xx), warn (4xx/5xx), or error. */
  tone: "success" | "warn" | "error" | "neutral";
}

interface ResponseSampleRow {
  response_json: string;
  status: "success" | "retry" | "dead";
  c: string | number;
}

/**
 * Distribution of response codes / error types for a destination's UNRESOLVED
 * outcomes — same definition as the workspace failure-type breakdown: retries
 * that eventually succeeded, replayed-and-recovered events, and
 * `already_delivered` dead-letters no longer show up as failures.
 *
 * The `response_json` field is destination-type-specific (HTTP destinations
 * carry `http_status`, others carry `error`). We bucket on JSON keys client-
 * side rather than parsing inside ClickHouse — the cardinality is small
 * (a handful of distinct values per destination) so the cost is negligible.
 */
export async function getDestinationResponseCodeDistribution(
  workspaceId: string,
  destinationId: string,
  windowHours = 24,
  deps: MetricsDeps = {},
): Promise<ResponseCodeBucket[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const start = isoSinceHours(now, windowHours);

  const result = await ch.query<ResponseSampleRow>(
    `SELECT outcome_response AS response_json, outcome_status AS status, count(*) AS c
       FROM (
         ${latestOutcomesCTE({ source: "attempts", scope: { destination: true } })}
       )
      WHERE NOT ${SUCCESS_PREDICATE}
      GROUP BY outcome_response, outcome_status`,
    { workspace_id: workspaceId, destination_id: destinationId, start },
  );

  const totals = new Map<string, { count: number; tone: ResponseCodeBucket["tone"] }>();
  for (const row of result.rows) {
    const parsed = safeParse(row.response_json);
    const bucket = bucketResponse(parsed, row.status);
    const count = ROW_CAST.toNumber(row.c);
    const existing = totals.get(bucket.label);
    if (existing) {
      existing.count += count;
    } else {
      totals.set(bucket.label, { count, tone: bucket.tone });
    }
  }
  return Array.from(totals.entries())
    .map(([bucket, v]) => ({ bucket, count: v.count, tone: v.tone }))
    .sort((a, b) => b.count - a.count);
}

function safeParse(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function bucketResponse(
  parsed: Record<string, unknown>,
  status: "success" | "retry" | "dead",
): { label: string; tone: ResponseCodeBucket["tone"] } {
  const httpStatus = parsed["http_status"];
  if (typeof httpStatus === "number" && Number.isFinite(httpStatus)) {
    if (httpStatus >= 200 && httpStatus < 300) return { label: `${httpStatus}`, tone: "success" };
    if (httpStatus >= 400 && httpStatus < 500) return { label: `${httpStatus}`, tone: "warn" };
    if (httpStatus >= 500) return { label: `${httpStatus}`, tone: "error" };
    return { label: `${httpStatus}`, tone: "neutral" };
  }
  const err = parsed["error"];
  if (typeof err === "string" && err.length > 0) {
    const label = (publicDeliveryErrorCode(err) ?? "delivery_failed").replace(/_/g, " ");
    return { label, tone: status === "dead" ? "error" : "warn" };
  }
  if (status === "success") return { label: "ok", tone: "success" };
  if (status === "dead") return { label: "failed", tone: "error" };
  return { label: "retry", tone: "warn" };
}

export interface DestinationRouteHealthRow {
  route_id: string;
  success: number;
  retry: number;
  dead: number;
  total: number;
  successRate: number;
  avgLatencyMs: number;
  lastAttemptAt: string | null;
}

/**
 * Per-route delivery health for a destination over a rolling window. Augments
 * the existing "Routes using this destination" table with live metrics.
 * Counts and success rate are over latest outcomes (canonical definition);
 * latency is the final attempt's latency per outcome.
 */
export async function getDestinationRouteHealth(
  workspaceId: string,
  destinationId: string,
  windowHours = 24,
  deps: MetricsDeps = {},
): Promise<DestinationRouteHealthRow[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const now = deps.now?.() ?? new Date();
  const start = isoSinceHours(now, windowHours);

  const result = await ch.query<{
    route_id: string;
    success: string | number;
    retry: string | number;
    dead: string | number;
    avg_latency_ms: string | number | null;
    last_attempt_at: string | null;
  }>(
    `SELECT route_id,
            countIf(${SUCCESS_PREDICATE}) AS success,
            countIf(outcome_status = 'retry') AS retry,
            countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead,
            avg(outcome_latency_ms) AS avg_latency_ms,
            toString(max(outcome_at)) AS last_attempt_at
       FROM (
         ${latestOutcomesCTE({ source: "attempts", scope: { destination: true } })}
       )
      GROUP BY route_id`,
    { workspace_id: workspaceId, destination_id: destinationId, start },
  );

  return result.rows.map((row) => {
    const success = ROW_CAST.toNumber(row.success);
    const retry = ROW_CAST.toNumber(row.retry);
    const dead = ROW_CAST.toNumber(row.dead);
    const total = success + retry + dead;
    return {
      route_id: row.route_id,
      success,
      retry,
      dead,
      total,
      successRate: total > 0 ? success / total : 0,
      avgLatencyMs: ROW_CAST.toNumber(row.avg_latency_ms),
      lastAttemptAt: nullableTs(row.last_attempt_at),
    };
  });
}

export interface RecentAttemptRow {
  attempt_id: string;
  event_id: string;
  route_id: string;
  attempt_no: number;
  status: "success" | "retry" | "dead";
  latency_ms: number;
  http_status: number | null;
  error: string | null;
  /** Why the delivery path suppressed this attempt (breaker/pause/rate limit), or null for a real attempt. */
  skip_reason: string | null;
  is_test: boolean;
  created_at: string;
}

/**
 * Most recent delivery attempts to this destination across all routes.
 * Each row is one (route, attempt_no) — multiple rows per event when retries
 * happened. `failuresOnly` drops successes so failures can't be crowded out
 * of the window by high-volume healthy traffic.
 *
 * Deliberately NOT deduplicated to latest outcomes: this is the raw attempts
 * log, and collapsing retries here would hide the retry history the page
 * exists to show.
 */
export async function listRecentDestinationAttempts(
  workspaceId: string,
  destinationId: string,
  limit = 25,
  deps: MetricsDeps = {},
  failuresOnly = false,
): Promise<RecentAttemptRow[]> {
  const ch = deps.clickhouse ?? clickhouse();

  const result = await ch.query<{
    attempt_id: string;
    event_id: string;
    route_id: string;
    attempt_no: string | number;
    status: "success" | "retry" | "dead";
    latency_ms: string | number;
    response_json: string;
    is_test: string | number;
    created_at: string;
  }>(
    `SELECT attempt_id,
            event_id,
            route_id,
            attempt_no,
            status,
            latency_ms,
            response_json,
            is_test,
            toString(created_at) AS created_at
       FROM delivery_attempts
      WHERE workspace_id = {workspace_id:String}
        AND destination_id = {destination_id:String}
        ${failuresOnly ? "AND status != 'success'" : ""}
      ORDER BY created_at DESC
      LIMIT {limit:UInt32}`,
    { workspace_id: workspaceId, destination_id: destinationId, limit },
  );

  return result.rows.map((row) => {
    const parsed = safeParse(row.response_json);
    const httpStatusRaw = parsed["http_status"];
    const errRaw = parsed["error"];
    return {
      attempt_id: row.attempt_id,
      event_id: row.event_id,
      route_id: row.route_id,
      attempt_no: ROW_CAST.toNumber(row.attempt_no),
      status: row.status,
      latency_ms: ROW_CAST.toNumber(row.latency_ms),
      http_status:
        typeof httpStatusRaw === "number" && Number.isFinite(httpStatusRaw) ? httpStatusRaw : null,
      error: publicDeliveryErrorCode(errRaw),
      skip_reason: skipReasonFrom(parsed),
      is_test: ROW_CAST.toNumber(row.is_test) === 1,
      created_at: row.created_at,
    };
  });
}

/**
 * Native-path skips log `{ skipped_by: "circuit_breaker", reason: "…" }`;
 * edge-path skips log `{ skipped: "…reason…" }`. Both used to render as a
 * blank "—" failure with 0ms latency — a mystery row on a page whose header
 * said Active.
 */
function skipReasonFrom(parsed: Record<string, unknown>): string | null {
  const reason = parsed["reason"];
  if (typeof reason === "string" && reason.length > 0 && "skipped_by" in parsed) return reason;
  const skipped = parsed["skipped"];
  if (typeof skipped === "string" && skipped.length > 0) return skipped;
  if (typeof parsed["skipped_by"] === "string") return parsed["skipped_by"] as string;
  return null;
}

export interface EdaPoint {
  /** Bucket key — depends on dimension (route_id, hour, status, etc.). */
  bucket: string;
  count: number;
  success: number;
  retry: number;
  dead: number;
  avg_latency_ms: number;
  p95_latency_ms: number;
}

export type EdaDimension = "hour" | "route" | "status" | "attempt_no";

/**
 * Flexible aggregation for the interactive EDA panel. Groups delivery
 * OUTCOMES (latest attempt per event/route, canonical definition) by one of
 * several dimensions over a rolling window.
 *
 * Hour buckets use the workspace timezone on the outcome timestamp; `status`
 * groups by the final status; `attempt_no` groups by the attempt number of
 * the final attempt — i.e. "how many tries this delivery took". Result is
 * sorted descending by count except hour, which is chronological.
 */
export async function getDestinationEdaSeries(
  workspaceId: string,
  destinationId: string,
  dimension: EdaDimension,
  windowHours: number,
  deps: MetricsDeps = {},
): Promise<EdaPoint[]> {
  const ch = deps.clickhouse ?? clickhouse();
  const timezone = normalizeWorkspaceTimezone(deps.timezone);
  const now = deps.now?.() ?? new Date();
  const start = isoSinceHours(now, windowHours);

  const bucketExpr =
    dimension === "hour"
      ? "toString(toStartOfInterval(outcome_at, INTERVAL 1 HOUR, {timezone:String}))"
      : dimension === "route"
        ? "route_id"
        : dimension === "status"
          ? "outcome_status"
          : "toString(outcome_attempt_no)";

  const orderClause = dimension === "hour" ? "ORDER BY bucket ASC" : "ORDER BY count DESC";

  const result = await ch.query<{
    bucket: string;
    count: string | number;
    success: string | number;
    retry: string | number;
    dead: string | number;
    avg_latency_ms: string | number | null;
    p95_latency_ms: string | number | null;
  }>(
    `SELECT ${bucketExpr}                        AS bucket,
            count(*)                             AS count,
            countIf(${SUCCESS_PREDICATE})        AS success,
            countIf(outcome_status = 'retry')    AS retry,
            countIf(${TERMINAL_FAILURE_PREDICATE}) AS dead,
            avg(outcome_latency_ms)              AS avg_latency_ms,
            quantile(0.95)(outcome_latency_ms)   AS p95_latency_ms
       FROM (
         ${latestOutcomesCTE({ source: "attempts", scope: { destination: true } })}
       )
      GROUP BY bucket
      ${orderClause}
      LIMIT 200`,
    { workspace_id: workspaceId, destination_id: destinationId, start, timezone },
  );

  return result.rows.map((row) => ({
    bucket: row.bucket,
    count: ROW_CAST.toNumber(row.count),
    success: ROW_CAST.toNumber(row.success),
    retry: ROW_CAST.toNumber(row.retry),
    dead: ROW_CAST.toNumber(row.dead),
    avg_latency_ms: ROW_CAST.toNumber(row.avg_latency_ms),
    p95_latency_ms: ROW_CAST.toNumber(row.p95_latency_ms),
  }));
}

/** Format milliseconds for compact display, e.g. 1234 -> "1.23s", 87 -> "87ms". */
export function formatLatency(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

/** Format a relative timestamp from a ClickHouse string. */
export function formatRelative(raw: string | null, now: Date = new Date()): string {
  if (!raw) return "never";
  const ts = Date.parse(raw.replace(" ", "T") + "Z");
  if (!Number.isFinite(ts)) return "—";
  const diffMs = now.getTime() - ts;
  if (diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
