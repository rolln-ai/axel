-- Migration 0051: clickwrap consent record (terms_acceptances).
--
-- Until now signup recorded no agreement to any legal terms — the form had no
-- consent checkbox and signUp() stored nothing. That left the Terms of Service,
-- Acceptable Use Policy, and Privacy Policy unenforceable: there was no proof a
-- user ever agreed to them. This table is the durable, defensible record of a
-- clickwrap acceptance.
--
-- One row is written per acceptance event (today: at signup, for both the
-- new-workspace owner and an invited member). It captures WHICH documents and
-- versions were agreed to (document_versions), the bundle version for cheap
-- filtering (terms_version), and the evidentiary context an acceptance needs to
-- hold up: timestamp, source IP, and user-agent. Keeping each acceptance as its
-- own row (rather than a column on users) means re-consent after a version bump
-- is just another append — the full history is preserved.
--
-- workspace_id is the tenant context at acceptance time (nullable / SET NULL so
-- deleting a workspace never erases the consent trail). The row is keyed to the
-- user and CASCADE-deletes with them, consistent with GDPR erasure.

CREATE TABLE IF NOT EXISTS terms_acceptances (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  terms_version text NOT NULL,                  -- bundle version, e.g. '1.0'
  document_versions jsonb NOT NULL,             -- { "terms": "1.0", "acceptable-use": "1.0", "privacy": "1.0" }
  context text NOT NULL DEFAULT 'signup'        -- 'signup' | 'invite_signup' | future 're_consent'
    CHECK (context IN ('signup', 'invite_signup', 're_consent')),
  ip text,
  user_agent text,
  accepted_at timestamptz NOT NULL DEFAULT now()
);

-- "What did this user agree to, most recent first" — the lookup for proving
-- consent and for detecting who still owes re-acceptance after a version bump.
CREATE INDEX IF NOT EXISTS terms_acceptances_user_idx
  ON terms_acceptances (user_id, accepted_at DESC);
