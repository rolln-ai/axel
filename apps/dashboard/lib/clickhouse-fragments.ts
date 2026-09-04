import "server-only";

/**
 * Shared ClickHouse SQL fragments for delivery-outcome analytics.
 *
 * This module is the single definition of what the dashboard means by
 * "the outcome of a delivery":
 *
 * - Retries collapse: only the LATEST attempt per
 *   `(base_event_id, route_id, destination_id)` counts (argMax by time).
 * - Replays collapse: a replayed event id carries a `#rpy_<id>` suffix so
 *   downstream idempotency keys differ; for analytics the replay REPLACES the
 *   original outcome, so event ids are normalized back to `base_event_id`
 *   before grouping.
 * - `already_delivered` dead-letters count as success: the destination
 *   already has the payload, so the delivery is not a failure.
 *
 * Every query that reports a success rate, failure breakdown, or outcome
 * count composes these fragments instead of re-typing the CTE — the three
 * copies in usage.ts and the third definition in destination-metrics.ts had
 * already drifted apart (replay normalization was missing from the workspace
 * summary's raw fallback, and destination metrics had neither dedup nor the
 * already_delivered exclusion).
 *
 * The rollup is a ReplacingMergeTree ordered by the complete outcome key.
 * FINAL merges its sorted rows without building an aggregate state per event.
 * The raw attempts fallback still needs GROUP BY + argMax because retries and
 * replays are separate log rows. Only the LOWER time bound goes into the scan: a
 * key's latest activity timestamp only grows, so the max row always survives
 * the pushdown. Any UPPER bound must stay in the OUTER query (on
 * `outcome_at`) so a key replayed after the window is excluded, not counted
 * at a stale version.
 */

/** Matches the `#rpy_<id>` suffix appended to replayed event ids. */
export const REPLAY_ID_SUFFIX_PATTERN = "#rpy_[A-Za-z0-9_-]+$";

/**
 * Normalizes a delivery-attempt event id back to the original ingest event id
 * so a replayed event counts as one delivery, not two.
 */
export const BASE_EVENT_ID_EXPR = `replaceRegexpOne(event_id, '${REPLAY_ID_SUFFIX_PATTERN}', '')`;

/**
 * Canonical "this delivery succeeded" predicate over the latest-outcome
 * columns produced by {@link latestOutcomesCTE}. A dead-letter whose error is
 * `already_delivered` means the destination already had the payload — success.
 */
export const SUCCESS_PREDICATE =
  "(outcome_status = 'success' OR (outcome_status = 'dead' AND JSONExtractString(outcome_response, 'error') = 'already_delivered'))";

/** The `already_delivered` pseudo-failure — excluded from every failure surface. */
export const ALREADY_DELIVERED_PREDICATE =
  "(outcome_status = 'dead' AND JSONExtractString(outcome_response, 'error') = 'already_delivered')";

/** Canonical terminal failure: dead AND not `already_delivered`. */
export const TERMINAL_FAILURE_PREDICATE =
  "(outcome_status = 'dead' AND JSONExtractString(outcome_response, 'error') != 'already_delivered')";

/**
 * Attempt rows the delivery path suppressed without contacting the destination
 * (breaker open, operator pause, retry-after window, rate limit). Native-path
 * skips carry `skipped_by`+`reason`, edge-path skips carry `skipped`; real
 * attempts carry neither. Predicate over the raw `response_json` column.
 */
export const SKIP_PREDICATE =
  "(JSONHas(response_json, 'skipped_by') OR JSONHas(response_json, 'skipped'))";

/** {@link SKIP_PREDICATE} over the `outcome_response` column of {@link latestOutcomesCTE}. */
export const OUTCOME_SKIP_PREDICATE =
  "(JSONHas(outcome_response, 'skipped_by') OR JSONHas(outcome_response, 'skipped'))";

export interface LatestOutcomesScope {
  /** Also filter the inner scan to `destination_id = {destination_id:String}`. */
  destination?: boolean;
  /** Exclude test traffic (`is_test = 0`). Only valid for the `attempts` source. */
  excludeTest?: boolean;
}

export interface LatestOutcomesOptions {
  /**
   * `rollup` reads the pre-normalized `delivery_base_latest_outcomes` table
   * (hot path); `attempts` recomputes the same collapse from raw
   * `delivery_attempts` (fallback for clusters without the rollup MV, and the
   * only source that can carry latency / attempt-number columns).
   */
  source: "rollup" | "attempts";
  scope?: LatestOutcomesScope;
}

/**
 * Builds the canonical latest-outcome-per-`(base_event_id, route_id,
 * destination_id)` subquery. Emits the columns:
 *
 * - `base_event_id`, `route_id`, `destination_id`
 * - `outcome_status`, `outcome_response`, `outcome_at`
 * - (`attempts` source only) `outcome_latency_ms`, `outcome_attempt_no` —
 *   the latency / attempt number of the final attempt.
 *
 * Binds `{workspace_id:String}` and `{start:String}` (lower time bound,
 * pushed into the inner scan), plus `{destination_id:String}` when
 * `scope.destination` is set. Callers apply any upper bound on `outcome_at`
 * in the outer query.
 */
export function latestOutcomesCTE(options: LatestOutcomesOptions): string {
  const scope = options.scope ?? {};

  if (options.source === "rollup") {
    if (scope.excludeTest) {
      throw new Error(
        "latestOutcomesCTE: excludeTest requires the attempts source — the rollup has no is_test column.",
      );
    }
    const destinationPredicate = scope.destination
      ? "\n              AND destination_id = {destination_id:String}"
      : "";
    return `SELECT base_event_id,
                  route_id,
                  destination_id,
                  latest_status   AS outcome_status,
                  latest_response AS outcome_response,
                  latest_at       AS outcome_at
             FROM delivery_base_latest_outcomes FINAL
            WHERE workspace_id = {workspace_id:String}
              AND latest_at >= parseDateTime64BestEffort({start:String}, 3)${destinationPredicate}`;
  }

  const destinationPredicate = scope.destination
    ? "\n                  AND destination_id = {destination_id:String}"
    : "";
  const testPredicate = scope.excludeTest ? "\n                  AND is_test = 0" : "";
  return `SELECT base_event_id,
                  route_id,
                  destination_id,
                  argMax(status, created_at)        AS outcome_status,
                  argMax(response_json, created_at) AS outcome_response,
                  argMax(latency_ms, created_at)    AS outcome_latency_ms,
                  argMax(attempt_no, created_at)    AS outcome_attempt_no,
                  max(created_at)                   AS outcome_at
             FROM (
               SELECT ${BASE_EVENT_ID_EXPR} AS base_event_id,
                      route_id,
                      destination_id,
                      status,
                      response_json,
                      latency_ms,
                      attempt_no,
                      created_at
                 FROM delivery_attempts
                WHERE workspace_id = {workspace_id:String}
                  AND created_at >= parseDateTime64BestEffort({start:String}, 3)${destinationPredicate}${testPredicate}
             )
            GROUP BY base_event_id, route_id, destination_id`;
}
