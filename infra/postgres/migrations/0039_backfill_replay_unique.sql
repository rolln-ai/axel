-- Migration 0039: dedupe backfill-generated replay_requests.
--
-- The backfill worker bulk-inserts one replay_requests row per event in a
-- window, then advances its cursor in the SAME transaction. If it crashes
-- between the INSERT commit and the next tick it re-pulls the same window;
-- previously each retry minted fresh rpl_ ids, so a crash could enqueue an
-- event's replay twice. This partial unique index backs an
-- ON CONFLICT (backfill_job_id, event_id) DO NOTHING in the worker, making
-- re-runs idempotent. Partial (backfill_job_id IS NOT NULL) so it never
-- constrains ordinary, non-backfill replay rows (which carry NULL).

CREATE UNIQUE INDEX IF NOT EXISTS replay_requests_backfill_event_uniq
  ON replay_requests (backfill_job_id, event_id)
  WHERE backfill_job_id IS NOT NULL;
