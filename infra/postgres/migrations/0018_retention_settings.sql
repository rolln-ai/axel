-- Migration 0018: configurable retention + transient mode (AXE-35).
--
-- Per-workspace retention defaults with per-source overrides. The
-- defaults match historical behaviour (90 days raw payload, 90 days
-- dead-letter / replay rows). Operators can lower to comply with
-- "don't store payloads beyond delivery" requirements (transient
-- mode = raw_payload_retention_days = 0).
--
-- Cleanup is enforced by `enforceRetention` in the delivery-service
-- (runs hourly). NULL on a source means "inherit the workspace
-- value", same shape as `max_body_bytes` / `max_body_depth`.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS raw_payload_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (raw_payload_retention_days >= 0 AND raw_payload_retention_days <= 3650),
  ADD COLUMN IF NOT EXISTS dead_letter_retention_days INTEGER NOT NULL DEFAULT 90
    CHECK (dead_letter_retention_days >= 1 AND dead_letter_retention_days <= 3650),
  ADD COLUMN IF NOT EXISTS replay_request_retention_days INTEGER NOT NULL DEFAULT 30
    CHECK (replay_request_retention_days >= 1 AND replay_request_retention_days <= 3650),
  ADD COLUMN IF NOT EXISTS audit_log_retention_days INTEGER NOT NULL DEFAULT 365
    CHECK (audit_log_retention_days >= 30 AND audit_log_retention_days <= 3650);

ALTER TABLE sources
  ADD COLUMN IF NOT EXISTS transient_mode BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS raw_payload_retention_days INTEGER
    CHECK (raw_payload_retention_days IS NULL OR (raw_payload_retention_days >= 0 AND raw_payload_retention_days <= 3650));

-- Cleanup helpers: indexes on the columns the cleanup queries scan.
CREATE INDEX IF NOT EXISTS dead_letters_errored_at_idx ON dead_letters (errored_at);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (created_at);
