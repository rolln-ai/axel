-- Axel analytical log schema.
-- Partition by day and order by tenant/time for high-volume append + search.

CREATE TABLE IF NOT EXISTS events
(
  workspace_id String,
  event_id String,
  source_id String,
  r2_key String,
  received_at DateTime64(3),
  content_type LowCardinality(String),
  size_bytes UInt32,
  shard UInt16,
  is_test Boolean DEFAULT false,
  headers_json String,
  query_json String,
  -- Event-type discriminator extracted from the payload body at ingest
  -- (see @axel/shared extractEventTypeFromBody). LowCardinality because a
  -- source emits a small fixed set of types. '' = unknown/untyped (non-JSON
  -- body or no discriminator). Lets Data Contract inference enumerate every
  -- distinct type with a GROUP BY instead of sampling the long tail blind.
  event_type LowCardinality(String) DEFAULT ''
)
ENGINE = MergeTree
PARTITION BY toDate(received_at)
ORDER BY (workspace_id, received_at, source_id, event_id)
TTL toDateTime(received_at) + INTERVAL 30 DAY;

-- Idempotent add for clusters provisioned before event_type existed. Safe to
-- re-run; ClickHouse no-ops when the column is already present.
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type LowCardinality(String) DEFAULT '';

-- Additive data-skipping index for the event_type discovery query
-- (sampler.sampleByEventTypeIndex). A bloom_filter skip index lets the
-- `WHERE event_type = ...` / `LIMIT BY event_type` scans prune granules that
-- don't contain a given type without rewriting the table. GRANULARITY 4 keeps
-- the index small for a low-cardinality column.
--
-- NOTE: this does NOT change the MergeTree ORDER BY — that would be a hot-path
-- table rebuild and is intentionally out of scope. The sampler's
-- `ORDER BY event_type, cityHash64(event_id) ... LIMIT BY event_type` sort cost
-- is accepted: it is bounded by the 30-day TTL window and the per-type LIMIT,
-- so the working set per source stays small.
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_event_type event_type TYPE bloom_filter GRANULARITY 4;

CREATE TABLE IF NOT EXISTS route_evaluations
(
  workspace_id String,
  event_id String,
  source_id String,
  route_id String,
  status LowCardinality(String),
  reason LowCardinality(String),
  duration_ms Float32,
  is_test Boolean DEFAULT false,
  evaluated_at DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toDate(evaluated_at)
ORDER BY (workspace_id, evaluated_at, route_id, event_id)
TTL toDateTime(evaluated_at) + INTERVAL 30 DAY;

CREATE TABLE IF NOT EXISTS delivery_attempts
(
  workspace_id String,
  event_id String,
  route_id String,
  destination_id String,
  attempt_id String,
  attempt_no UInt16,
  status LowCardinality(String),
  latency_ms UInt32,
  response_json String,
  is_test Boolean DEFAULT false,
  created_at DateTime64(3)
)
ENGINE = MergeTree
PARTITION BY toDate(created_at)
ORDER BY (workspace_id, created_at, destination_id, event_id, attempt_no)
TTL toDateTime(created_at) + INTERVAL 30 DAY;

-- Backfill `is_test` onto tables that pre-date the column being added
-- (the CREATE TABLE IF NOT EXISTS statements above are a no-op for tables
-- created before `is_test` existed, so without these ALTERs the billing
-- rollup `WHERE is_test = false` fails with Code: 47 in production).
-- `ADD COLUMN IF NOT EXISTS` keeps this idempotent for re-applies.
ALTER TABLE events ADD COLUMN IF NOT EXISTS is_test Boolean DEFAULT false;
ALTER TABLE route_evaluations ADD COLUMN IF NOT EXISTS is_test Boolean DEFAULT false;
ALTER TABLE delivery_attempts ADD COLUMN IF NOT EXISTS is_test Boolean DEFAULT false;

-- Dashboard rollups ---------------------------------------------------------
--
-- ClickHouse data-skipping indexes help point lookups, but they do not make
-- the dashboard's daily totals and latest-delivery-outcome rollups cheap at
-- scale. These materialized views keep the hot dashboard reads bounded:
--
-- - events_daily turns event volume charts and top-source lists into one row
--   per workspace/day/source.
-- - delivery_latest_outcomes keeps one current row per
--   workspace/event/route/destination, so the dashboard does not repeatedly
--   group raw retry attempts and run argMax over the full attempts window.

CREATE TABLE IF NOT EXISTS events_daily
(
  workspace_id String,
  day Date,
  source_id String,
  events AggregateFunction(uniqExact, String),
  bytes SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
PARTITION BY day
ORDER BY (workspace_id, day, source_id)
TTL toDateTime(day) + INTERVAL 30 DAY;

INSERT INTO events_daily
SELECT
  workspace_id,
  toDate(received_at) AS day,
  source_id,
  uniqExactState(event_id) AS events,
  sum(toUInt64(size_bytes)) AS bytes
FROM events
-- Exclude test events so the usage rollup reconciles with billing (which counts
-- WHERE is_test = false). Counting them here made the dashboard usage KPI diverge
-- permanently from the invoice (audit).
WHERE is_test = false AND NOT EXISTS (SELECT 1 FROM events_daily LIMIT 1)
GROUP BY workspace_id, day, source_id;

-- NOTE: changing a live MV requires `DROP VIEW events_daily_mv` then re-applying
-- this file (CREATE … IF NOT EXISTS won't replace an existing view), and only
-- affects NEW inserts — historical events_daily rows predating this filter still
-- include test events and need a one-time recompute to fully reconcile.
CREATE MATERIALIZED VIEW IF NOT EXISTS events_daily_mv
TO events_daily
AS
SELECT
  workspace_id,
  toDate(received_at) AS day,
  source_id,
  uniqExactState(event_id) AS events,
  sum(toUInt64(size_bytes)) AS bytes
FROM events
WHERE is_test = false
GROUP BY workspace_id, day, source_id;

CREATE TABLE IF NOT EXISTS delivery_latest_outcomes
(
  workspace_id String,
  event_id String,
  route_id String,
  destination_id String,
  latest_status LowCardinality(String),
  latest_response String,
  latest_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(latest_at)
PARTITION BY tuple()
ORDER BY (workspace_id, event_id, route_id, destination_id)
TTL toDateTime(latest_at) + INTERVAL 30 DAY;

INSERT INTO delivery_latest_outcomes
SELECT
  workspace_id,
  event_id,
  route_id,
  destination_id,
  argMax(status, created_at) AS latest_status,
  argMax(response_json, created_at) AS latest_response,
  max(created_at) AS latest_at
FROM delivery_attempts
WHERE NOT EXISTS (SELECT 1 FROM delivery_latest_outcomes LIMIT 1)
GROUP BY workspace_id, event_id, route_id, destination_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS delivery_latest_outcomes_mv
TO delivery_latest_outcomes
AS
SELECT
  workspace_id,
  event_id,
  route_id,
  destination_id,
  status AS latest_status,
  response_json AS latest_response,
  created_at AS latest_at
FROM delivery_attempts;

-- Normalized current delivery outcome per original event.
--
-- Replays deliberately suffix event_id with `#rpy_...` so downstream
-- idempotency keys differ from the original delivery. For dashboard outcomes,
-- the replay should replace the original failed outcome once it succeeds.
-- This rollup stores the latest outcome by base_event_id, avoiding a
-- per-request regexp + argMax over delivery_latest_outcomes.

CREATE TABLE IF NOT EXISTS delivery_base_latest_outcomes
(
  workspace_id String,
  base_event_id String,
  route_id String,
  destination_id String,
  latest_status LowCardinality(String),
  latest_response String,
  latest_at DateTime64(3)
)
ENGINE = ReplacingMergeTree(latest_at)
PARTITION BY tuple()
ORDER BY (workspace_id, base_event_id, route_id, destination_id)
TTL toDateTime(latest_at) + INTERVAL 30 DAY;

INSERT INTO delivery_base_latest_outcomes
SELECT
  workspace_id,
  replaceRegexpOne(event_id, '#rpy_[A-Za-z0-9_-]+$', '') AS base_event_id,
  route_id,
  destination_id,
  argMax(status, created_at) AS latest_status,
  argMax(response_json, created_at) AS latest_response,
  max(created_at) AS latest_at
FROM delivery_attempts
WHERE NOT EXISTS (SELECT 1 FROM delivery_base_latest_outcomes LIMIT 1)
GROUP BY workspace_id, base_event_id, route_id, destination_id;

CREATE MATERIALIZED VIEW IF NOT EXISTS delivery_base_latest_outcomes_mv
TO delivery_base_latest_outcomes
AS
SELECT
  workspace_id,
  replaceRegexpOne(event_id, '#rpy_[A-Za-z0-9_-]+$', '') AS base_event_id,
  route_id,
  destination_id,
  status AS latest_status,
  response_json AS latest_response,
  created_at AS latest_at
FROM delivery_attempts;
