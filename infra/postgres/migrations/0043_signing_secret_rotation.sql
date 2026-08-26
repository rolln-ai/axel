-- Migration 0043: dual signing-secret rotation window.
--
-- Keep the previous signing secret during an overlap window so inbound webhooks
-- still signed with the old secret keep verifying while a customer rotates (the
-- ingest worker accepts a signature matching EITHER current or previous). Once
-- the window passes, the dashboard clears the previous columns.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_previous_ciphertext bytea;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_previous_fingerprint text;
ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_rotated_at timestamptz;
