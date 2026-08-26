-- Migration 0034: backfill schema_migrations rows for 0024–0033.
--
-- Companion to 0033 (the tracker creation). The first run of
-- `migrate-postgres-run.yml` against existing prod re-applied
-- 0001–0023 (idempotent — safe) and recorded each. Then it tried
-- 0024 which is `ALTER TABLE event_maps RENAME TO data_contracts` —
-- already done years ago — and threw, leaving 0024–0033 untracked.
--
-- Mark the remaining files as `'legacy'` so the next runner pass
-- finds the whole history in the tracker and is a true no-op until
-- 0035+ lands.
--
-- The script's auto-backfill (which gates on `destinations` existing)
-- now handles new prod DBs going forward; this file exists to repair
-- the half-applied state from the first manual run.

INSERT INTO schema_migrations (filename, sha256) VALUES
  ('0024_event_maps_rename_to_data_contracts.sql',     'legacy'),
  ('0025_destinations_strip_route_bound_config.sql',   'legacy'),
  ('0025_edkg_foundation.sql',                         'legacy'),
  ('0026_edkg_connector_configs.sql',                  'legacy'),
  ('0027_edkg_enabled_flag.sql',                       'legacy'),
  ('0028_destinations_restore_route_bound_config.sql', 'legacy'),
  ('0029_replay_resolution_indexes.sql',               'legacy'),
  ('0030_active_replay_dashboard_indexes.sql',         'legacy'),
  ('0031_replay_failure_reason_rollup.sql',            'legacy'),
  ('0032_dead_letter_resolved_at.sql',                 'legacy'),
  ('0033_schema_migrations.sql',                       'legacy'),
  ('0034_backfill_legacy_rest.sql',                    'legacy')
ON CONFLICT (filename) DO NOTHING;
