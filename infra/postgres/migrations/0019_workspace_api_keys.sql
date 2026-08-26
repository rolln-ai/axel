-- Migration 0019: workspace-scoped API keys for the REST control plane (AXE-29).
--
-- Mirrors the personal-access-token shape from 0011 but scoped to a
-- single workspace + with role-style scopes. Stored as a SHA-256 hex
-- hash; we keep the first 8 chars of the plaintext as `key_prefix`
-- so the dashboard can render `axl_xxxxxxxx…` in the list (no full
-- plaintext after creation, ever).

CREATE TABLE IF NOT EXISTS workspace_api_keys (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  name text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  -- Scope strings. The middleware checks for membership; the dashboard
  -- restricts the offered set. Adding a new scope here doesn't require
  -- a schema migration on consumers — just check the new string.
  --   read         : GET endpoints
  --   write        : POST/PUT/PATCH/DELETE on sources/destinations/routes
  --   replay       : POST /v1/replays
  --   admin        : everything above + key management
  scopes text[] NOT NULL DEFAULT '{read}',
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK (cardinality(scopes) > 0)
);

CREATE INDEX IF NOT EXISTS workspace_api_keys_workspace_idx
  ON workspace_api_keys (workspace_id) WHERE revoked_at IS NULL;
