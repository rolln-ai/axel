-- 0058_destinations_bigquery_type.sql
-- 2026-07-08
--
-- Allow 'bigquery' as a destination type. The BigQuery connector (PR #256)
-- added the type in code + schema.sql, but the live `destinations_type_check`
-- constraint (last set in migration 0001) never listed it, so inserting a
-- BigQuery destination failed with:
--   new row for relation "destinations" violates check constraint
--   "destinations_type_check"
--
-- Idempotent: drops the existing constraint by name, then re-adds it with the
-- full allow-list. Adding an allowed value never invalidates existing rows, so
-- this is safe to apply ahead of / independent of a code deploy.

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
    'databricks_volume',
    'bigquery'
  ));

COMMIT;
