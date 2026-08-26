-- Migration 0027: per-workspace EDKG enable flag.
--
-- Drives the scheduler cron and the backfill cron: only workspaces with
-- edkg_enabled=true participate in automated EDKG runs. The dashboard
-- buttons (manual backfill, manual lint) work regardless — owners can
-- always run things on demand even before the workspace is enrolled.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS edkg_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS workspaces_edkg_enabled_idx
  ON workspaces (edkg_enabled) WHERE edkg_enabled = TRUE;
