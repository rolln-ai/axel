-- Migration 0033: schema_migrations tracker.
--
-- Records which infra/postgres/migrations/*.sql files have been applied
-- against this database, so the runner (scripts/run-migrations.sh) can
-- skip already-applied ones and only run pending. Before this table
-- existed, the only way to keep prod's schema in sync with the repo
-- was to manually pick migration files and run them with psql — which
-- led to AXE-150 (migration 0014 sat un-applied for two cycles, and
-- the bug only surfaced when a customer-impacting CHECK constraint
-- rejected a valid INSERT).
--
-- The runner does the legacy backfill itself, gated on whether
-- `destinations` (a table from 0001) is already present — see
-- scripts/run-migrations.sh. This file just creates the tracker
-- table for fresh DBs; the runner's INSERT loop will then mark this
-- file as applied with its real sha256 once it runs.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename text PRIMARY KEY,
  sha256 text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
