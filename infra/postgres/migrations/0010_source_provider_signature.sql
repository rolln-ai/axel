-- Migration 0010: per-provider inbound webhook signature verification
-- (AXE-23).
--
-- Adds provider metadata + a per-source signing secret to `sources` so
-- the ingest worker can reject spoofed requests before they reach R2 /
-- the queue. Today, sources authenticate by `x-axel-token` only —
-- which is fine when *we* mint the secret, but inadequate for
-- third-party providers (Stripe, GitHub, Shopify, …) that mint their
-- own per-endpoint signing secrets and sign every payload with HMAC.
--
-- Storage:
--   - `provider`                        — preset key (custom | stripe |
--     github | shopify). 'custom' means "no provider preset; rely on
--     the source token alone, OR optionally on the Axel custom-HMAC
--     scheme".
--   - `signing_secret_ciphertext`       — AES-256-GCM ciphertext of
--     the plaintext provider secret. Wrapped with the same
--     CREDENTIALS_MASTER_KEY the destinations subsystem uses; the
--     dashboard owns encryption + decryption. The 12-byte nonce is
--     prepended to the ciphertext bytes (`[nonce | ct | gcm-tag]`).
--   - `signing_secret_fingerprint`      — short hex digest of the
--     plaintext (first 12 chars of SHA-256). Lets the dashboard show
--     "secret ending in …" without ever decrypting the bytes.
--
-- The ciphertext column is bytea, not text, so we don't pay for
-- base64 storage on every row. NULL means "no signing secret
-- configured" — only token auth applies.

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'custom'
    CHECK (provider IN ('custom', 'stripe', 'github', 'shopify'));

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_ciphertext bytea;

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS signing_secret_fingerprint text;
