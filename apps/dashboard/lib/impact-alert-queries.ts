// Payload-free monitoring queries. Tested against disposable databases.
export const FLOW_ACTIVITY_SQL = `
SELECT source_id, toString(max(received_at)) AS last_received, count() AS samples,
       quantileExactIf(0.95)(gap_seconds, gap_seconds > 0) AS typical_gap_seconds
FROM (
  SELECT source_id, received_at,
    dateDiff('second', lagInFrame(received_at, 1, received_at) OVER
      (PARTITION BY source_id ORDER BY received_at ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), received_at) AS gap_seconds
  FROM (
    SELECT source_id, received_at FROM events
    WHERE workspace_id = {workspace_id:String} AND is_test = false
      AND received_at >= now() - INTERVAL 30 DAY
    ORDER BY received_at DESC LIMIT 2000 BY source_id
  )
)
GROUP BY source_id`;

// Duplicate analytics inserts retain the immutable event receipt time. ANY
// prevents those copies from multiplying outcomes without a large GROUP BY.
export const DELIVERY_ACTIVITY_SQL = `
SELECT route_id, destination_id,
  toString(maxIf(latest_at, latest_status = 'success' OR JSONExtractString(latest_response, 'error') = 'already_delivered')) AS last_delivered,
  countIf(latest_status = 'retry' AND received_at < now() - INTERVAL 30 MINUTE) AS waiting_count,
  countIf(latest_status = 'dead' AND JSONExtractString(latest_response, 'error') IN
    ('bigquery_schema_mismatch', 'bigquery_row_rejected')) AS schema_failures,
  countIf(latest_status = 'dead' AND JSONExtractInt(latest_response, 'http_status') IN (401, 403)) AS auth_failures
FROM (SELECT * FROM delivery_base_latest_outcomes FINAL WHERE workspace_id = {workspace_id:String}) outcomes
INNER ANY JOIN (SELECT event_id, received_at FROM events
  WHERE workspace_id = {workspace_id:String} AND is_test = false) accepted
  ON outcomes.base_event_id = accepted.event_id
GROUP BY route_id, destination_id`;

// Only unconditional declarative routes qualify. Filtered/transformed routes
// may intentionally drop events, so their health uses actual failures/retries.
export const UNATTEMPTED_SQL = `
SELECT count() AS waiting_count FROM (
  SELECT DISTINCT event_id FROM events
  WHERE workspace_id = {workspace_id:String} AND source_id = {source_id:String}
    AND is_test = false AND received_at >= parseDateTimeBestEffort({route_created:String})
    AND received_at >= now() - INTERVAL 7 DAY AND received_at < now() - INTERVAL 30 MINUTE
) e LEFT ANY JOIN (
  SELECT base_event_id, toUInt8(1) AS attempted FROM delivery_base_latest_outcomes FINAL
  WHERE workspace_id = {workspace_id:String} AND route_id = {route_id:String}
    AND destination_id = {destination_id:String}
) d ON e.event_id = d.base_event_id
WHERE coalesce(d.attempted, 0) = 0`;

// A failed replay is another attempt at the same event, not additional lost data.
// A later confirmed replay of the original supersedes its older failure rows.
// Manual dismissal and success at another route/destination do not qualify.
export const DEAD_LETTER_COUNTS_SQL = `
SELECT dl.source_id, dl.route_id, dl.destination_id,
       count(DISTINCT regexp_replace(dl.event_id, '#rpy_[A-Za-z0-9_-]+$', ''))::text AS count,
       count(*) FILTER (WHERE dl.errored_at >= now() - interval '7 days')::text AS recent_count
FROM dead_letters dl WHERE dl.workspace_id = $1 AND dl.resolved_at IS NULL AND dl.is_test = false
  AND NOT EXISTS (
    SELECT 1 FROM dead_letters delivered
    WHERE delivered.workspace_id = dl.workspace_id
      AND delivered.event_id = regexp_replace(dl.event_id, '#rpy_[A-Za-z0-9_-]+$', '')
      AND delivered.route_id IS NOT DISTINCT FROM dl.route_id
      AND delivered.destination_id IS NOT DISTINCT FROM dl.destination_id
      AND delivered.resolved_by_replay_id IS NOT NULL
      AND delivered.resolved_at >= dl.errored_at
  )
GROUP BY dl.source_id, dl.route_id, dl.destination_id`;
