-- Migration 0054: idempotency for the erasure-subjects index write.
--
-- The ingest worker now populates erasure_subjects (migration 0046 created the
-- table inert; the write-path was unimplemented until release 1.0.4). It writes
-- one row per (subject_id, event_id) via ctx.waitUntil. Cloudflare can re-deliver
-- an ingest request, so the writer uses ON CONFLICT DO NOTHING against this
-- unique index to stay idempotent and keep the index from growing duplicates.
--
-- Replaces the plain lookup index from 0046 with a UNIQUE one on the same
-- leading columns (workspace_id, subject_id) plus event_id — it still serves the
-- (workspace_id, subject_id) point lookup the finder uses.

CREATE UNIQUE INDEX IF NOT EXISTS erasure_subjects_ws_subject_event_uniq
  ON erasure_subjects (workspace_id, subject_id, event_id);

DROP INDEX IF EXISTS erasure_subjects_lookup_idx;
