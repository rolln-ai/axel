-- Migration 0014: widen pull_sources.type to cover databases (AXE-60).
--
-- The original 0003 constraint only allowed `'chargebee'`. Stripe +
-- Shopify pulls landed in code without ever updating it; on most prod
-- DBs the constraint is simply stale (no Stripe/Shopify pulls created
-- yet) but we want to fix the lie before adding postgres / mongodb /
-- bigquery rows that would also be rejected.
--
-- Drop whatever pull_sources.type CHECK exists, then re-add one with
-- the full set: API pulls (chargebee/stripe/shopify) plus the new
-- database pulls (postgres/mongodb/bigquery). Safely idempotent.

DO $$
DECLARE
  cons RECORD;
BEGIN
  -- Drop every existing CHECK constraint on pull_sources.type, no
  -- matter what it's named. Constraint names auto-generate based on
  -- whether the table was created at the wrong time, so we can't
  -- assume a stable name.
  FOR cons IN
    SELECT conname
      FROM pg_constraint
      JOIN pg_class ON pg_class.oid = pg_constraint.conrelid
     WHERE pg_class.relname = 'pull_sources'
       AND contype = 'c'
       AND pg_get_constraintdef(pg_constraint.oid) LIKE '%type%'
  LOOP
    EXECUTE format('ALTER TABLE pull_sources DROP CONSTRAINT %I', cons.conname);
  END LOOP;
END$$;

ALTER TABLE pull_sources
  ADD CONSTRAINT pull_sources_type_check
  CHECK (type IN ('chargebee', 'stripe', 'shopify', 'postgres', 'mongodb', 'bigquery'));
