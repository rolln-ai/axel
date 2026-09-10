-- Source-specific incidents and a durable, per-recipient email outbox.
-- Monitoring preferences do not participate in ingest authorization.
ALTER TABLE sources ADD COLUMN IF NOT EXISTS alert_after_minutes integer
  CHECK (alert_after_minutes BETWEEN 15 AND 10080);
ALTER TABLE sources ADD COLUMN IF NOT EXISTS flow_monitoring_enabled boolean NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS sources_workspace_identity_idx ON sources(workspace_id, id);

CREATE TABLE IF NOT EXISTS pipeline_incidents (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) ON DELETE CASCADE,
  incident_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('source_silent','delivery_blocked')),
  snapshot jsonb NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  observed_at timestamptz NOT NULL DEFAULT now(),
  healthy_since timestamptz,
  resolved_at timestamptz,
  acknowledged_until timestamptz,
  next_reminder_at timestamptz NOT NULL DEFAULT now() + interval '6 hours',
  sequence integer NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_incidents_open_idx
  ON pipeline_incidents(workspace_id, incident_key) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS pipeline_incidents_workspace_idx
  ON pipeline_incidents(workspace_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS alert_email_outbox (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  incident_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  phase text NOT NULL CHECK (phase IN ('opened','reminder','recovered')),
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','sending','sent','cancelled','needs_review')),
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  first_attempt_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  claim_id text,
  sent_at timestamptz,
  provider_message_id text,
  FOREIGN KEY (workspace_id, incident_id) REFERENCES pipeline_incidents(workspace_id, id) ON DELETE CASCADE,
  UNIQUE (incident_id, sequence, user_id)
);
CREATE INDEX IF NOT EXISTS alert_email_outbox_pending_idx
  ON alert_email_outbox(next_attempt_at) WHERE state IN ('pending','sending');

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS impact_monitor_checked_at timestamptz;

-- Upgrade existing installations without assuming capability-role names.
-- Only the dashboard profile can insert AND update notification preferences.
-- Fresh installations receive the same privileges from the service profiles.
DO $impact_grants$
DECLARE dashboard_grantee record;
BEGIN
  FOR dashboard_grantee IN
    SELECT r.rolname FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND c.relname = 'notification_preferences'
      AND a.grantee <> c.relowner AND a.privilege_type IN ('INSERT', 'UPDATE')
    GROUP BY r.rolname HAVING count(DISTINCT a.privilege_type) = 2
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pipeline_incidents, public.alert_email_outbox TO %I', dashboard_grantee.rolname);
  END LOOP;
END
$impact_grants$;
