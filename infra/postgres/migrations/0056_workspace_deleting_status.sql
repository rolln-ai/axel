-- Migration 0056: async workspace deletion ("deleting" lifecycle state)
--
-- Self-serve workspace deletion used to run the entire teardown — thousands of
-- per-object R2 deletes + synchronous ClickHouse mutations — inline in the
-- server action, which hung the UI for minutes and risked the 300s function
-- timeout (leaving a half-wiped shell). Deletion is now two-phase: the action
-- flips the workspace to 'deleting' (snappy, redirects immediately) and a cron
-- sweep (app/api/cron/workspace-teardown) does the heavy teardown out of band.
--
-- Adds:
--   * 'deleting' to the workspaces.status CHECK (interim teardown state)
--   * usage_flushed_at — marks that the final metered usage was reported to the
--     Stripe meter; gates a settle delay before the subscription is canceled so
--     the final invoice includes every event sent before deletion.
--   * a partial index the sweep scans.
--
-- Matching declarative definitions live in infra/postgres/schema.sql.

-- The status CHECK was created inline via ADD COLUMN, so its name is
-- auto-generated. Look it up by definition and drop it before re-adding a named
-- constraint that includes 'deleting'. Idempotent: re-running finds the new
-- named constraint and rewrites it in place.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
    FROM pg_constraint
   WHERE conrelid = 'workspaces'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%status%'
     AND pg_get_constraintdef(oid) ILIKE '%active%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE workspaces DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE workspaces
  ADD CONSTRAINT workspaces_status_check
  CHECK (status IN ('active', 'suspended', 'deleted', 'deleting'));

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS usage_flushed_at timestamptz;

-- The teardown sweep scans oldest-first for workspaces awaiting teardown.
CREATE INDEX IF NOT EXISTS workspaces_deleting_idx
  ON workspaces (deleted_at) WHERE status = 'deleting';
