-- Migration 0004: Admin section
--
-- Adds the super-admin flag, workspace lifecycle columns, and impersonation
-- markers on user_sessions. All operations are idempotent so re-running is
-- safe. The matching declarative definitions live in `infra/postgres/schema.sql`.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_super_admin boolean NOT NULL DEFAULT false;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'deleted'));
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspended_by_user_id text
  REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS suspension_reason text;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS impersonator_user_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS impersonator_returns_to_session_id text;

CREATE INDEX IF NOT EXISTS user_sessions_impersonator_idx
  ON user_sessions (impersonator_user_id) WHERE impersonator_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workspaces_status_idx
  ON workspaces (status) WHERE status <> 'active';
