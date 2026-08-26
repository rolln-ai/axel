-- Migration 0020: component heartbeats for the operational view.
--
-- Each worker writes a row per tick so the /admin/health page (and
-- the public /status page) can answer "is everything actually
-- running?". `/health` endpoints only prove the process is up; they
-- don't prove its work loop is making forward progress. A frozen
-- pull-worker or a CF consumer with a poison-pill batch can leave
-- `/health` green while events silently pile up.
--
-- Schema is one row per component (e.g. "delivery-service",
-- "pull-worker", "ingest-worker", "router-edge", "retention-loop").
-- last_seen updates via UPSERT; last_tick_count is a monotonic
-- counter so even if `last_seen` is fresh, a stuck `last_tick_count`
-- exposes a wedged loop. expected_interval_seconds drives the
-- red/yellow/green badge per component (operators can override per-
-- row since pull-worker naturally ticks less often than ingest).

CREATE TABLE IF NOT EXISTS component_heartbeats (
  component text PRIMARY KEY,
  environment text,
  last_seen timestamptz NOT NULL DEFAULT now(),
  last_tick_count bigint NOT NULL DEFAULT 0,
  last_error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  expected_interval_seconds integer NOT NULL DEFAULT 60,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Cheap lookup on the badge query ("what's stale?").
CREATE INDEX IF NOT EXISTS component_heartbeats_last_seen_idx
  ON component_heartbeats (last_seen);
