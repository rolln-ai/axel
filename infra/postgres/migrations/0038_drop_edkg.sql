-- Migration 0038: drop the EDKG (Event Data Knowledge Graph) subsystem.
--
-- The EDKG worker, packages, dashboard surface, and crons were removed as
-- product bloat (orphaned from the capture -> route -> deliver path, gated
-- off by default via workspaces.edkg_enabled, half its connectors were PR7
-- stubs). This migration removes the schema those components owned so the
-- tables stop accruing rows and the control-plane DB footprint shrinks.
--
-- Forward-only and idempotent: every statement is IF EXISTS / CASCADE, so it
-- is a no-op on environments where EDKG was never applied. The historical
-- create migrations (0025-0027) are intentionally retained as ledger history;
-- this migration supersedes them.

BEGIN;

-- Knowledge-graph core + derived tables (CASCADE clears their indexes/FKs).
DROP TABLE IF EXISTS edkg_embeddings CASCADE;
DROP TABLE IF EXISTS edkg_page_versions CASCADE;
DROP TABLE IF EXISTS edkg_pages CASCADE;
DROP TABLE IF EXISTS edkg_edges CASCADE;
DROP TABLE IF EXISTS edkg_nodes CASCADE;
DROP TABLE IF EXISTS edkg_provenance CASCADE;
DROP TABLE IF EXISTS edkg_action_log CASCADE;
DROP TABLE IF EXISTS edkg_lint_findings CASCADE;
DROP TABLE IF EXISTS edkg_agent_runs CASCADE;
DROP TABLE IF EXISTS edkg_job_queue CASCADE;
DROP TABLE IF EXISTS edkg_source_cursors CASCADE;
DROP TABLE IF EXISTS edkg_connector_configs CASCADE;

-- Per-workspace enrolment flag added by 0027 (dropping the column also drops
-- its partial index workspaces_edkg_enabled_idx).
DROP INDEX IF EXISTS workspaces_edkg_enabled_idx;
ALTER TABLE workspaces DROP COLUMN IF EXISTS edkg_enabled;

COMMIT;
