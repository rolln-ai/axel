CREATE INDEX CONCURRENTLY IF NOT EXISTS replay_requests_recovery_idx
  ON replay_requests (workspace_id, source_id, (split_part(event_id, '#', 1)))
  WHERE state IN ('pending', 'in_progress');

-- An interrupted concurrent build can leave an invalid index. Never record
-- the migration as applied merely because IF NOT EXISTS found that object.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.replay_requests_recovery_idx'::regclass AND indisvalid) THEN
    RAISE EXCEPTION 'recovery_index_invalid';
  END IF;
END $$;
