-- Migration 0046: subject -> event index for GDPR erasure (Phase 1 foundation).
--
-- Written at ingest (a later phase) for sources that opted into
-- subject_key_paths: one row per (event_id, subject_id) pair. `subject_id` is a
-- HASHED locator (sha256 over workspace_id + kind + normalized value), never
-- the raw PII — so this index is a pseudonymous pointer, not a durable copy of
-- the subject's data. The stored r2_key + received_at let the executor scope
-- R2 deletes and partition-prune ClickHouse mutations without scanning.
--
-- An erasure request resolves a subject to its event set via a point lookup on
-- (workspace_id, subject_id); the (workspace_id, event_id) index supports the
-- reverse lookup used when an event is erased for other reasons.
--
-- Phase 1 creates the table only — no code writes it yet (inert).

CREATE TABLE IF NOT EXISTS erasure_subjects (
  id bigserial PRIMARY KEY,
  workspace_id text NOT NULL,
  subject_id text NOT NULL,          -- hashed locator, never raw PII
  event_id text NOT NULL,
  r2_key text,                       -- ingest raw key; other R2 copies derived at erase time
  received_at timestamptz NOT NULL,
  indexed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS erasure_subjects_lookup_idx
  ON erasure_subjects (workspace_id, subject_id);
CREATE INDEX IF NOT EXISTS erasure_subjects_event_idx
  ON erasure_subjects (workspace_id, event_id);
