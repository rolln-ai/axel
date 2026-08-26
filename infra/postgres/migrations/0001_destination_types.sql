-- 0001_destination_types.sql
-- 2026-05-06
--
-- Allow `webhook`, `databricks_sql`, and `databricks_volume` as destination
-- types. The `webhook` type was already in use in code but the original
-- schema.sql CHECK constraint never listed it; the two databricks types are
-- new in this change. Production DBs created from an older schema.sql must
-- run this migration before the dashboard can insert these types.
--
-- Idempotent: drops the existing constraint (if any) by name, then re-adds
-- it with the full allow-list. Running twice is a no-op.

BEGIN;

ALTER TABLE destinations DROP CONSTRAINT IF EXISTS destinations_type_check;

ALTER TABLE destinations
  ADD CONSTRAINT destinations_type_check
  CHECK (type IN (
    'mongodb',
    'postgres',
    'r2',
    's3',
    'http',
    'webhook',
    'databricks_sql',
    'databricks_volume'
  ));

COMMIT;
