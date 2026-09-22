-- Throttle on pending AND dispatched work; inspect outcomes without scanning
-- unrelated replay history on every recovery tick.
CREATE INDEX CONCURRENTLY IF NOT EXISTS replay_requests_backfill_state_idx
  ON replay_requests (backfill_job_id, state) WHERE backfill_job_id IS NOT NULL;

-- An interrupted concurrent build can leave an invalid index. Never record
-- the migration as applied merely because IF NOT EXISTS found that object.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.replay_requests_backfill_state_idx'::regclass AND indisvalid) THEN
    RAISE EXCEPTION 'recovery_index_invalid';
  END IF;
END $$;
