-- Migration 0023: async backfill jobs.
--
-- Replaces the in-process `enqueueSourceBackfill` (AXE-66 v1) which capped at
-- 10k events because:
--   - one giant ClickHouse SELECT into a single HTTP response would OOM the
--     dashboard for a multi-million-row source
--   - one giant bulk-INSERT into replay_requests would create unbounded queue
--     depth (millions of rows), bloating the table and overwhelming any
--     downstream destination with a sudden flood
--
-- The job model paginates ClickHouse one window at a time and throttles by
-- "max in-flight replays for this job", so a backfill drains at the rate
-- the router actually delivers — never faster.

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  route_id text NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  source_id text NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  since timestamptz NOT NULL,
  until timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  total_estimated bigint,
  enqueued bigint NOT NULL DEFAULT 0,
  cursor_received_at timestamptz,
  cursor_event_id text,
  max_inflight_replays integer NOT NULL DEFAULT 1000,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

CREATE INDEX IF NOT EXISTS backfill_jobs_active_idx
  ON backfill_jobs (requested_at)
  WHERE state IN ('pending', 'running');

CREATE INDEX IF NOT EXISTS backfill_jobs_workspace_idx
  ON backfill_jobs (workspace_id, requested_at DESC);

-- Link replay_requests back to the backfill job that created them so the
-- worker can throttle on a per-job basis (instead of counting every pending
-- replay in the workspace, which would conflate dashboard "Retry" clicks
-- with the job's own queue depth).
ALTER TABLE replay_requests
  ADD COLUMN IF NOT EXISTS backfill_job_id text REFERENCES backfill_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS replay_requests_backfill_job_pending_idx
  ON replay_requests (backfill_job_id)
  WHERE state = 'pending' AND backfill_job_id IS NOT NULL;
