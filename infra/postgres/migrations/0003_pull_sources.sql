-- Pull-based ELT source configuration and checkpoints.
--
-- Webhook sources continue to live in `sources`; pull_sources are scheduled
-- extractors (Chargebee first) whose emitted records can be routed through the
-- same downstream delivery pipeline.

CREATE TABLE IF NOT EXISTS pull_sources (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('chargebee')),
  config jsonb NOT NULL,
  credentials_ref text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  schedule_cron text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pull_sources_workspace_status_idx
  ON pull_sources (workspace_id, status);

CREATE TABLE IF NOT EXISTS pull_source_credentials (
  id text PRIMARY KEY,
  pull_source_id text NOT NULL REFERENCES pull_sources(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  nonce bytea NOT NULL,
  auth_tag bytea NOT NULL,
  fingerprint_last4 text NOT NULL,
  fingerprint_sha256_prefix text NOT NULL,
  encryption_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pull_source_credentials_source_idx
  ON pull_source_credentials (pull_source_id);

CREATE TABLE IF NOT EXISTS pull_source_stream_state (
  pull_source_id text NOT NULL REFERENCES pull_sources(id) ON DELETE CASCADE,
  stream text NOT NULL,
  cursor jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pull_source_id, stream)
);

CREATE TABLE IF NOT EXISTS pull_sync_runs (
  id text PRIMARY KEY,
  pull_source_id text NOT NULL REFERENCES pull_sources(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  records_emitted integer NOT NULL DEFAULT 0,
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message text
);

CREATE INDEX IF NOT EXISTS pull_sync_runs_source_time_idx
  ON pull_sync_runs (pull_source_id, started_at DESC);

CREATE INDEX IF NOT EXISTS pull_sync_runs_workspace_time_idx
  ON pull_sync_runs (workspace_id, started_at DESC);
