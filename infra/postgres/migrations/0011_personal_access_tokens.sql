-- Migration 0011: personal access tokens (AXE-26).
--
-- The Axel CLI authenticates against delivery-service via a workspace-
-- scoped PAT minted from the dashboard's Settings → Tokens page. Stored
-- as a SHA-256 hash (the same scheme as `sources.secret_token_hash`) so
-- a leaked DB doesn't yield usable tokens. The plaintext is shown to
-- the user exactly once at mint time.
--
-- Scope is "workspace + user": every PAT belongs to a single (user,
-- workspace) pair so revoking a user from a workspace also takes their
-- CLI access with them. PATs inherit the user's role at the time the
-- request is made — no separate per-token RBAC for MVP.
--
-- The `last_used_at` column is updated by the auth middleware on every
-- successful request so operators can spot stale tokens. The
-- `expires_at` column is nullable today (PATs are infinite by default);
-- a future "rotate quarterly" UI can populate it.

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- SHA-256 hex of the plaintext token. Constant-time-compared against
  -- the presented credential. Never logged.
  token_hash text NOT NULL,
  -- Optional human label so operators can recognise "laptop" vs "ci"
  -- in the dashboard list view.
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);

-- Lookup index: every authenticated CLI request hashes the presented
-- token and looks up by the hash to find the workspace/user. Without
-- this index the auth middleware would seq-scan the table on every
-- call.
CREATE UNIQUE INDEX IF NOT EXISTS personal_access_tokens_hash_idx
  ON personal_access_tokens (token_hash);

-- Listing index: the dashboard PAT panel sorts by created_at desc per
-- user; this keeps that page fast as tokens accumulate.
CREATE INDEX IF NOT EXISTS personal_access_tokens_user_idx
  ON personal_access_tokens (workspace_id, user_id, created_at DESC);
