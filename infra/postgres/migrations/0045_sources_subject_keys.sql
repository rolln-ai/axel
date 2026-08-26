-- Migration 0045: per-source GDPR subject-key config (erasure Phase 1).
--
-- Opt-in, default-inert. `subject_key_paths` holds operator-configured paths to
-- the data-subject identifier(s) on an event — body dot-paths and/or
-- header/query names, each tagged with a location and informational kind, e.g.
--   [{"loc":"body","path":"data.customer.email","kind":"email"},
--    {"loc":"header","path":"x-customer-id","kind":"id"}]
-- A later phase extracts those values at ingest and indexes them (hashed) so a
-- per-subject erasure request is a cheap lookup instead of a full store scan.
--
-- `subject_indexing_active_since` is stamped when a source first gets
-- subject_key_paths; erasure requests use it to disclose the pre-feature window
-- that the index cannot cover (events ingested earlier have no index row).
--
-- Phase 1 adds config only — NULL default means zero extraction and no behavior
-- change for existing sources.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS subject_key_paths jsonb;
ALTER TABLE sources ADD COLUMN IF NOT EXISTS subject_indexing_active_since timestamptz;
