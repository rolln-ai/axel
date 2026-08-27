-- Keep incremental installations aligned with the canonical schema snapshot.
-- Fresh databases have carried this field since test deliveries were added,
-- but older Axel Cloud databases never received an append-only migration.

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;
