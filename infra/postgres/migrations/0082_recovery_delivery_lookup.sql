-- Keep delivery writes available during index construction. Replay event IDs
-- append #rpy_ / #rpl_; recovery checks the original event identity too.
CREATE INDEX CONCURRENTLY IF NOT EXISTS delivery_idempotency_recovery_idx
  ON delivery_idempotency (workspace_id, route_id, destination_id, (split_part(event_id, '#', 1)))
  WHERE state IN ('completed', 'in_flight');

-- An interrupted concurrent build can leave an invalid index. Never record
-- the migration as applied merely because IF NOT EXISTS found that object.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_index WHERE indexrelid='public.delivery_idempotency_recovery_idx'::regclass AND indisvalid) THEN
    RAISE EXCEPTION 'recovery_index_invalid';
  END IF;
END $$;
