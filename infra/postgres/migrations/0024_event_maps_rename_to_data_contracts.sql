-- Migration 0024: rename Event Maps → Data Contracts.
--
-- Naming change only. "Data Contract" is the established industry term
-- (dbt, Confluent, Atlan, Soda) for what these tables already represent:
-- a versioned, drift-detected agreement between a producer and a
-- consumer, with breaking-change gates. The coinage "Event Map" was
-- functional but didn't carry that weight.
--
-- All rows preserved. Foreign keys, primary keys, sequences, and check
-- constraints come along automatically via RENAME. Indexes need to be
-- renamed explicitly so future EXPLAIN output / index_stats queries
-- stay readable.
--
-- App code, URL slugs (/event-maps/* → /data-contracts/*), and Vercel
-- cron paths are updated in the same release. A Next.js permanent
-- redirect handles legacy bookmarks.

-- Tables ---------------------------------------------------------------------

ALTER TABLE event_maps RENAME TO data_contracts;
ALTER TABLE event_map_versions RENAME TO data_contract_versions;
ALTER TABLE event_map_fixtures RENAME TO data_contract_fixtures;
ALTER TABLE event_map_drift_events RENAME TO data_contract_drift_events;

-- Foreign-key columns. The column data is identical; we just want the
-- name to match the new table.
ALTER TABLE data_contract_versions
  RENAME COLUMN event_map_id TO data_contract_id;
ALTER TABLE data_contract_fixtures
  RENAME COLUMN event_map_version_id TO data_contract_version_id;
ALTER TABLE data_contract_drift_events
  RENAME COLUMN event_map_id TO data_contract_id;
ALTER TABLE data_contract_drift_events
  RENAME COLUMN event_map_version_id TO data_contract_version_id;

-- Indexes --------------------------------------------------------------------
-- Postgres doesn't auto-rename indexes when the underlying table renames,
-- so do this explicitly. Names match what migration 0006 would produce
-- if rewritten from scratch.

ALTER INDEX event_maps_workspace_source_idx
  RENAME TO data_contracts_workspace_source_idx;
ALTER INDEX event_maps_workspace_status_idx
  RENAME TO data_contracts_workspace_status_idx;
ALTER INDEX event_maps_workspace_lower_name_idx
  RENAME TO data_contracts_workspace_lower_name_idx;

ALTER INDEX event_map_versions_map_created_idx
  RENAME TO data_contract_versions_map_created_idx;

ALTER INDEX event_map_fixtures_version_idx
  RENAME TO data_contract_fixtures_version_idx;

ALTER INDEX event_map_drift_events_unresolved_idx
  RENAME TO data_contract_drift_events_unresolved_idx;
ALTER INDEX event_map_drift_events_workspace_time_idx
  RENAME TO data_contract_drift_events_workspace_time_idx;

-- Sequence owned by event_map_drift_events.id (bigserial) is renamed
-- by PG along with the table, but the sequence object itself keeps the
-- legacy name. Rename it for consistency.
ALTER SEQUENCE event_map_drift_events_id_seq
  RENAME TO data_contract_drift_events_id_seq;
