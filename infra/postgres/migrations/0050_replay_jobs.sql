-- Migration 0050: tracked "replay all unresolved" jobs.
--
-- The "Replay all N unresolved" button on /deliveries bulk-inserted up to N
-- replay_requests rows in a single transaction, wrote one audit_log row, and
-- returned an ephemeral toast. There was no durable progress object an
-- operator could watch (queued / in-flight / succeeded / failed) and no
-- inbox/notification feedback when the batch finished. Worse, "replayed" !=
-- "resolved": a replay that fails again leaves its dead_letter unresolved,
-- so a toast saying "Queued 1,897 replays" overstated the outcome.
--
-- This adds a replay_jobs row per bulk-replay click (mirroring backfill_jobs)
-- so the dashboard can render live progress and the delivery-service worker
-- can detect completion and emit one "replay_job_complete" notification.
-- replay_requests gains a nullable replay_job_id linking each queued replay
-- back to its job; single-row "Retry" clicks leave it NULL.
--
-- succeeded_count/failed_count are denormalized on the job so completion
-- detection and the terminal notification are cheap; the live UI prefers a
-- GROUP BY over replay_requests.state and the worker recomputes the
-- authoritative counts in the atomic finish UPDATE.

CREATE TABLE IF NOT EXISTS replay_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  reason text NOT NULL,
  reason_filter text,
  total bigint NOT NULL DEFAULT 0,
  state text NOT NULL CHECK (state IN ('pending', 'running', 'done', 'failed', 'cancelled')),
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  error_message text
);

-- Dashboard reads the most recent active job per workspace; the worker's
-- completion path also keys on this. Index covers both the (workspace_id,
-- state) lookup required by the design and the active-job scan.
CREATE INDEX IF NOT EXISTS replay_jobs_workspace_state_idx
  ON replay_jobs (workspace_id, state);

CREATE INDEX IF NOT EXISTS replay_jobs_active_idx
  ON replay_jobs (requested_at)
  WHERE state IN ('pending', 'running');

-- Link replay_requests back to the replay_jobs row that created them so the
-- worker can (a) count remaining in-flight rows for completion detection and
-- (b) attribute succeeded/failed deltas to the right job. Nullable + IF NOT
-- EXISTS = fast metadata-only ADD COLUMN, safe on the populated table; ON
-- DELETE SET NULL so deleting a job leaves the replays intact (mirrors
-- replay_requests.backfill_job_id, migration 0023).
ALTER TABLE replay_requests
  ADD COLUMN IF NOT EXISTS replay_job_id text REFERENCES replay_jobs(id) ON DELETE SET NULL;

-- Completion check scans replay_requests WHERE replay_job_id=$1 AND state IN
-- ('pending','in_progress'); a partial index keeps that cheap and never
-- constrains ordinary non-job replays (NULL replay_job_id).
CREATE INDEX IF NOT EXISTS replay_requests_replay_job_idx
  ON replay_requests (replay_job_id)
  WHERE replay_job_id IS NOT NULL;
