-- Migration 0021: hourly snapshot of component heartbeat status
-- for the /status + /admin/health uptime sparkline.
--
-- One row per (component, bucket_start) where bucket_start is the
-- start of the hour. Status captured from the live row in
-- component_heartbeats at write time. Retention loop prunes rows
-- older than 7d so the table stays tiny (~168 buckets × N
-- components).
--
-- ON CONFLICT lets the retention loop be safely re-runnable inside
-- the same hour bucket — the latest status wins, no duplicates.

CREATE TABLE IF NOT EXISTS component_heartbeat_history (
  component text NOT NULL,
  bucket_start timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('green', 'yellow', 'red', 'unknown')),
  PRIMARY KEY (component, bucket_start)
);

-- Cheap sweep by bucket_start for the prune query + sparkline reads.
CREATE INDEX IF NOT EXISTS component_heartbeat_history_bucket_idx
  ON component_heartbeat_history (bucket_start);
