-- Migration 0022: per-route destination binding.
--
-- Today the destination row carries the "where do we write to" piece
-- (postgres.table, mongo.collection, s3.key_prefix, databricks volume,
-- etc.) directly in `destinations.config`. That ties a destination to
-- a single table/collection/prefix, so customers have to create N
-- destinations to write to N tables — even when they all use the same
-- credentials.
--
-- This migration moves that piece to `route_destinations.binding` so a
-- single Postgres/Mongo/Databricks/S3 destination can fan out to many
-- targets via separate routes.
--
-- `destinations.config` keeps the same fields for back-compat: rows
-- without a binding still resolve via the destination's defaults. New
-- code reads `binding` first, falls back to `destinations.config`.
--
-- Backfill: for every existing route_destinations row, copy the
-- relevant fields from the destination's config into binding so the
-- live behavior is unchanged after this migration runs.

ALTER TABLE route_destinations
  ADD COLUMN IF NOT EXISTS binding jsonb;

-- Postgres: { table, payload_column?, mode: "jsonb_blob" }
UPDATE route_destinations rd
   SET binding = jsonb_strip_nulls(jsonb_build_object(
         'table',          d.config->>'table',
         'payload_column', d.config->>'payload_column',
         'mode',           'jsonb_blob'
       ))
  FROM destinations d
 WHERE rd.destination_id = d.id
   AND d.type = 'postgres'
   AND rd.binding IS NULL
   AND d.config ? 'table';

-- MongoDB: { collection, idempotency_field? }
UPDATE route_destinations rd
   SET binding = jsonb_strip_nulls(jsonb_build_object(
         'collection',        d.config->>'collection',
         'idempotency_field', d.config->>'idempotency_field'
       ))
  FROM destinations d
 WHERE rd.destination_id = d.id
   AND d.type = 'mongodb'
   AND rd.binding IS NULL
   AND d.config ? 'collection';

-- Databricks SQL: { table, payload_column? }
UPDATE route_destinations rd
   SET binding = jsonb_strip_nulls(jsonb_build_object(
         'table',          d.config->>'table',
         'payload_column', d.config->>'payload_column'
       ))
  FROM destinations d
 WHERE rd.destination_id = d.id
   AND d.type = 'databricks_sql'
   AND rd.binding IS NULL
   AND d.config ? 'table';

-- Databricks Volume: { volume, key_prefix?, key_template? }
UPDATE route_destinations rd
   SET binding = jsonb_strip_nulls(jsonb_build_object(
         'volume',       d.config->>'volume',
         'key_prefix',   d.config->>'key_prefix',
         'key_template', d.config->>'key_template'
       ))
  FROM destinations d
 WHERE rd.destination_id = d.id
   AND d.type = 'databricks_volume'
   AND rd.binding IS NULL
   AND d.config ? 'volume';

-- S3 / R2: { key_prefix?, key_template? }
UPDATE route_destinations rd
   SET binding = jsonb_strip_nulls(jsonb_build_object(
         'key_prefix',   d.config->>'key_prefix',
         'key_template', d.config->>'key_template'
       ))
  FROM destinations d
 WHERE rd.destination_id = d.id
   AND d.type IN ('s3', 'r2')
   AND rd.binding IS NULL
   AND (d.config ? 'key_prefix' OR d.config ? 'key_template');
