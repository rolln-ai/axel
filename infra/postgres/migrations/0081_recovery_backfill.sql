-- Recovery jobs preserve confirmed deliveries and pin the reviewed route.
-- Ordinary user-requested backfills retain their explicit redelivery behavior.
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS recovery_destination_id text;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS recovery_route_updated_at timestamptz;
ALTER TABLE backfill_jobs ADD COLUMN IF NOT EXISTS skipped bigint NOT NULL DEFAULT 0;
