-- Migration 0008: in-app notifications (AXE-48).
--
-- The repo had Sonner toasts + transactional email via Resend but no
-- persistent in-app notification surface. Drift detection (AXE-47) and
-- the upcoming failure-explanation flow (AXE-49) write here.

CREATE TABLE IF NOT EXISTS notifications (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Nullable user_id = workspace-wide notification (visible to every member).
  user_id text REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'high')),
  title text NOT NULL,
  body_md text,
  link_path text,
  -- Dedup key, e.g. "event_map_drift:em_xyz:type_change:amount". Combined
  -- with the partial unique index below, prevents a noisy publisher from
  -- repeatedly inserting the same unread notification.
  dedup_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE INDEX IF NOT EXISTS notifications_workspace_user_idx
  ON notifications (workspace_id, COALESCE(user_id, ''), created_at DESC);

CREATE INDEX IF NOT EXISTS notifications_workspace_unread_idx
  ON notifications (workspace_id, created_at DESC)
  WHERE read_at IS NULL;

-- Prevent duplicate unread notifications with the same dedup_key. NULL
-- dedup_keys are exempt (legitimate use case: one-off ad-hoc messages).
-- The COALESCE handles workspace-wide rows (user_id IS NULL) cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS notifications_active_dedup_idx
  ON notifications (workspace_id, COALESCE(user_id, ''), kind, dedup_key)
  WHERE read_at IS NULL AND dedup_key IS NOT NULL;

-- Per-(workspace, user) delivery preferences. Stored as a JSONB blob so we
-- can add new channels (Slack, push, …) without further migrations.
-- Shape: { in_app: bool, email_immediate: bool, email_digest_daily: bool }.
CREATE TABLE IF NOT EXISTS notification_preferences (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
