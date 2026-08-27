-- Super-admin accounts must enroll an authenticator and complete a recent
-- step-up before any platform-wide read or mutation. Secrets are AES-GCM
-- encrypted by the dashboard under CREDENTIALS_MASTER_KEY.

CREATE TABLE IF NOT EXISTS admin_mfa_methods (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_ciphertext bytea NOT NULL,
  enabled_at timestamptz,
  last_used_counter bigint CHECK (last_used_counter IS NULL OR last_used_counter >= 0),
  enrollment_session_token_hash text,
  enrollment_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE admin_mfa_methods
  ADD COLUMN IF NOT EXISTS enrollment_session_token_hash text;

ALTER TABLE admin_mfa_methods
  ADD COLUMN IF NOT EXISTS enrollment_expires_at timestamptz;

ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS admin_mfa_verified_at timestamptz;

CREATE INDEX IF NOT EXISTS user_sessions_admin_mfa_verified_idx
  ON user_sessions (user_id, admin_mfa_verified_at DESC)
  WHERE admin_mfa_verified_at IS NOT NULL;
