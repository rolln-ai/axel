-- Migration 0025: strip route-bindable fields from destinations.config.
--
-- Migration 0022 added `route_destinations.binding` and backfilled it
-- from the matching `destinations.config` fields, so every existing
-- (route_id, destination_id) pair already carries the per-route target
-- on the join row.
--
-- This migration finishes the move: it removes those fields from
-- `destinations.config` so the dashboard's "Edit configuration" form
-- (driven by destination-defaults.ts schemas, which no longer list
-- them) stops showing stale Collection / Table / Key prefix fields,
-- and the connectors' legacy fallback path becomes dead code.
--
-- This is safe because:
--   * The connectors prefer `route_destinations.binding` over
--     `destinations.config` — routers have been deploying with
--     binding-aware queue messages since migration 0022 landed.
--   * Backfilled bindings exactly mirror the previous config values,
--     so no data is lost for routes that already existed.
--   * Orphan destinations (no routes yet) lose their pre-binding
--     defaults — but they couldn't deliver anywhere either, so no
--     in-flight delivery is affected.
--
-- Idempotent: the `-` operator on a jsonb key that doesn't exist is a
-- no-op, so re-running this migration is safe.

UPDATE destinations
   SET config = config - 'table' - 'payload_column',
       updated_at = now()
 WHERE type = 'postgres'
   AND (config ? 'table' OR config ? 'payload_column');

UPDATE destinations
   SET config = config - 'collection' - 'idempotency_field',
       updated_at = now()
 WHERE type = 'mongodb'
   AND (config ? 'collection' OR config ? 'idempotency_field');

UPDATE destinations
   SET config = config - 'table' - 'payload_column',
       updated_at = now()
 WHERE type = 'databricks_sql'
   AND (config ? 'table' OR config ? 'payload_column');

UPDATE destinations
   SET config = config - 'volume' - 'key_prefix' - 'key_template',
       updated_at = now()
 WHERE type = 'databricks_volume'
   AND (config ? 'volume' OR config ? 'key_prefix' OR config ? 'key_template');

UPDATE destinations
   SET config = config - 'key_prefix' - 'key_template',
       updated_at = now()
 WHERE type IN ('s3', 'r2')
   AND (config ? 'key_prefix' OR config ? 'key_template');
