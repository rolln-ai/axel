-- 0002_workspace_timezone.sql
-- 2026-05-07
--
-- Store the reporting timezone used by workspace analytics. ClickHouse keeps
-- event timestamps in UTC; dashboard rollups convert them to this timezone
-- before grouping by day/hour.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
