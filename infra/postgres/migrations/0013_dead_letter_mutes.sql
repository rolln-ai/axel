-- Migration 0013: dead-letter fingerprint mutes (AXE-57).
--
-- Operators investigating a noisy outage want to silence "all the
-- dead letters that look like X" without losing the underlying
-- per-event records. The inbox-zero page (AXE-57) lets them mute a
-- fingerprint for a chosen window; muted rows still exist in
-- dead_letters but disappear from the inbox view until `until` passes.
--
-- Fingerprint shape (computed in app code, not the DB): a stable
-- string built from (route_id, reason, message_slug) — see
-- packages/shared or the inbox helper for the canonical formula. We
-- intentionally store fingerprints as opaque text so the formula can
-- evolve without a migration.

CREATE TABLE IF NOT EXISTS dead_letter_mutes (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  /** Optional human note for the mute ("known Stripe outage 2026-05-15"). */
  reason text,
  /** When the mute expires. NULL = indefinite. */
  until timestamptz,
  muted_by_user_id text REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Note on uniqueness: PG won't accept a partial unique index whose
-- predicate uses `now()` (functions in index predicates must be
-- IMMUTABLE), and a true unique index on (workspace_id, fingerprint)
-- would block re-muting after a mute expires. Uniqueness of *active*
-- mutes is enforced in app code (lib/inbox-actions.ts) via SELECT-
-- then-UPDATE-or-INSERT. The lookup index below keeps that path fast.

-- The inbox query joins by (workspace_id, fingerprint) on every
-- render, so a covering index makes the lookup O(log n).
CREATE INDEX IF NOT EXISTS dead_letter_mutes_workspace_fingerprint_idx
  ON dead_letter_mutes (workspace_id, fingerprint);
