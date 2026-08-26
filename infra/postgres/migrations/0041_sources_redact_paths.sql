-- Migration 0041: per-source PII redaction paths.
--
-- Dot-paths (with `[]` to descend arrays, e.g. "user.email",
-- "customer.cards[].cvv") that the ingest worker masks with "[REDACTED]" in
-- the JSON body BEFORE writing it to R2 — so the masked fields never persist
-- and are never delivered downstream. NULL/empty = no redaction (default).
--
-- NOTE: this branch was cut from main; if the Chargebee branch
-- (0040_sources_provider_chargebee.sql) lands after this, renumber one of them
-- so migration ordinals stay unique.

ALTER TABLE sources ADD COLUMN IF NOT EXISTS redact_paths jsonb;
