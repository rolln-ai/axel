-- Migration 0005: Per-workspace name uniqueness for sources and destinations.
--
-- The dashboard already runs `SELECT 1 FROM sources WHERE workspace_id = $1
-- AND lower(name) = lower($2)` inside transactions to reject duplicate names,
-- but with the default READ COMMITTED isolation two concurrent transactions
-- can both see "no duplicate" and both INSERT. The unique indexes below let
-- Postgres reject the second INSERT and turn the race into a clean error.
--
-- NULL handling: lower(NULL) is NULL, and Postgres treats NULL keys as not
-- equal under UNIQUE — so legacy rows with NULL `name` (e.g. destinations
-- seeded before the name column was added) don't conflict with each other.

CREATE UNIQUE INDEX IF NOT EXISTS sources_workspace_lower_name_idx
  ON sources (workspace_id, lower(name));

CREATE UNIQUE INDEX IF NOT EXISTS destinations_workspace_lower_name_idx
  ON destinations (workspace_id, lower(name));
