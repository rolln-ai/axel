-- Migration 0053: store the dead-letter fingerprint on the row (Theme D).
--
-- The fingerprint (stable hash of route_id + reason + normalised message slug)
-- was computed only in app JS (apps/dashboard/lib/inbox.ts) and lived nowhere
-- on the row. The inbox could group + mute by it, but the BULK replay paths
-- ("Replay all unresolved", per-source/reason replay, multi-select) run entirely
-- in Postgres and so had no way to skip the fingerprints an operator had muted —
-- a "replay all" re-flooded the very failures they'd silenced.
--
-- Storing the fingerprint lets those SQL paths anti-join dead_letter_mutes
-- (migration 0013) and drop muted rows. The value is still computed in app code
-- (now @axel/shared `deadLetterFingerprint`, Web Crypto) and written by every
-- dead_letters writer (delivery-edge insertEdgeDeadLetter + the DLQ recorder,
-- delivery-service createPgDeadLetterSink), so the column stays opaque text and
-- the formula can still evolve without a migration — same contract as 0013.
--
-- Nullable on purpose: every row written before this migration (and the brief
-- window before the writers ship) has none. A NULL fingerprint never matches a
-- mute, so those rows are still replayable; run
-- scripts/backfill-dead-letter-fingerprints.mjs to populate history so
-- pre-existing muted backlogs are also respected by bulk replay.

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS fingerprint text;

-- Drives the bulk-replay candidate scan + the mute anti-join over the unresolved
-- working set (the only rows bulk replay ever considers). Partial on
-- resolved_at IS NULL to stay small. The probe side of the anti-join is covered
-- by dead_letter_mutes_workspace_fingerprint_idx (migration 0013).
CREATE INDEX IF NOT EXISTS dead_letters_workspace_fingerprint_unresolved_idx
  ON dead_letters (workspace_id, fingerprint)
  WHERE resolved_at IS NULL;
