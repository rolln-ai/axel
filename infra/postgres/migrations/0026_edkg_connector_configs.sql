-- Migration 0026: EDKG external connector configs.
--
-- Per-workspace configuration rows for the external-system connectors
-- introduced in PR7. Credentials live in encrypted_config (decrypted at
-- runtime by the worker using CREDENTIALS_MASTER_KEY, mirroring how
-- destinations.config and credentials work today).

CREATE TABLE IF NOT EXISTS edkg_connector_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,
  name                TEXT NOT NULL,
  config              JSONB NOT NULL DEFAULT '{}'::jsonb,
  encrypted_config    BYTEA,
  status              TEXT NOT NULL DEFAULT 'disabled'
                        CHECK (status IN ('disabled', 'active', 'errored')),
  last_error          TEXT,
  last_run_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS edkg_connector_configs_workspace_idx
  ON edkg_connector_configs (workspace_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS edkg_connector_configs_workspace_name_uniq
  ON edkg_connector_configs (workspace_id, name);
