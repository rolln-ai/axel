-- Migration 0028: un-strip migration 0025.
--
-- Migration 0025 stripped `table`, `payload_column`, `collection`,
-- `key_prefix`, `key_template`, etc. from `destinations.config`, on the
-- assumption that every delivery path read `route_destinations.binding`
-- first and fell back to `destinations.config` only "for defense in
-- depth on a race during deploys."
--
-- That was not true. `apps/delivery-edge/src/index.ts` — the Cloudflare
-- Worker that handles every postgres / s3 / r2 delivery — never read
-- `message.binding`. With the legacy config keys stripped, those
-- connectors had no target to write to:
--   * postgres: `config.table` undefined → INSERT into "undefined"
--   * s3      : `config.key_prefix` / `key_template` undefined →
--               default template, wrong keys
--   * r2      : same as s3
--
-- This migration restores those keys from `route_destinations.binding`
-- so the legacy fallback works again. Once delivery-edge is binding-
-- aware (follow-up commit) we can re-strip safely.
--
-- Idempotent: jsonb concat (`||`) overwrites existing keys with the
-- same value, so re-running is a no-op.

-- Postgres
UPDATE destinations d
   SET config = config || jsonb_strip_nulls(jsonb_build_object(
         'table',          rd.binding->>'table',
         'payload_column', rd.binding->>'payload_column'
       )),
       updated_at = now()
  FROM route_destinations rd
 WHERE rd.destination_id = d.id
   AND d.type = 'postgres'
   AND rd.binding IS NOT NULL
   AND rd.binding ? 'table'
   AND NOT (d.config ? 'table');

-- MongoDB
UPDATE destinations d
   SET config = config || jsonb_strip_nulls(jsonb_build_object(
         'collection',        rd.binding->>'collection',
         'idempotency_field', rd.binding->>'idempotency_field'
       )),
       updated_at = now()
  FROM route_destinations rd
 WHERE rd.destination_id = d.id
   AND d.type = 'mongodb'
   AND rd.binding IS NOT NULL
   AND rd.binding ? 'collection'
   AND NOT (d.config ? 'collection');

-- Databricks SQL
UPDATE destinations d
   SET config = config || jsonb_strip_nulls(jsonb_build_object(
         'table',          rd.binding->>'table',
         'payload_column', rd.binding->>'payload_column'
       )),
       updated_at = now()
  FROM route_destinations rd
 WHERE rd.destination_id = d.id
   AND d.type = 'databricks_sql'
   AND rd.binding IS NOT NULL
   AND rd.binding ? 'table'
   AND NOT (d.config ? 'table');

-- Databricks Volume
UPDATE destinations d
   SET config = config || jsonb_strip_nulls(jsonb_build_object(
         'volume',       rd.binding->>'volume',
         'key_prefix',   rd.binding->>'key_prefix',
         'key_template', rd.binding->>'key_template'
       )),
       updated_at = now()
  FROM route_destinations rd
 WHERE rd.destination_id = d.id
   AND d.type = 'databricks_volume'
   AND rd.binding IS NOT NULL
   AND rd.binding ? 'volume'
   AND NOT (d.config ? 'volume');

-- S3 / R2 — restore prefix + template. The destination may legitimately
-- have neither (use built-in defaults), so only restore when the binding
-- carries a value.
UPDATE destinations d
   SET config = config || jsonb_strip_nulls(jsonb_build_object(
         'key_prefix',   rd.binding->>'key_prefix',
         'key_template', rd.binding->>'key_template'
       )),
       updated_at = now()
  FROM route_destinations rd
 WHERE rd.destination_id = d.id
   AND d.type IN ('s3', 'r2')
   AND rd.binding IS NOT NULL
   AND (rd.binding ? 'key_prefix' OR rd.binding ? 'key_template')
   AND NOT (d.config ? 'key_prefix' OR d.config ? 'key_template');
