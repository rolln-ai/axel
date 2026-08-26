-- Migration 0064: email-verification tokens.
--
-- signUp() historically minted a fully-privileged account and session without
-- ever proving mailbox ownership, and users.email_verified_at (already in the
-- schema, displayed in the admin panel) was never written by any code path.
--
-- A row here is one outstanding "confirm your address" link. Deliberately the
-- same shape and lifecycle as password_resets: sha256(token) stored (never the
-- plaintext), single-use via used_at, TTL enforced by expires_at, and the
-- issuing code bounds live tokens per user. Confirming a token stamps
-- users.email_verified_at. See apps/dashboard/lib/email-verification.ts.

CREATE TABLE IF NOT EXISTS email_verifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  requested_ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_verifications_user_idx
  ON email_verifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS email_verifications_expiry_idx
  ON email_verifications (expires_at)
  WHERE used_at IS NULL;
