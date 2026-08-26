-- Migration 0052: notification alert lane (alerted_at + active-error ledger).
--
-- The notifications table + daily digest already exist (0008). This adds the
-- two pieces the user-facing alert system needs:
--
--   1. notifications.alerted_at — set when the IMMEDIATE alert lane has already
--      emailed a notification, so the daily digest (lib/data-contracts/
--      email-digest.ts) can exclude it and we never send the same item twice
--      (once now via the alert email, once in the next day's digest).
--
--   2. notification_active_errors — the resolve-aware dedup ledger that decides
--      whether a dead-letter fingerprint is a NEW error worth emailing about.
--      A row exists while a fingerprint is actively failing. The 15-min scan
--      (lib/notification-scan.ts) inserts it on first sight (INSERT ... ON
--      CONFLICT DO NOTHING RETURNING — the row that RETURNs is the one that
--      sends the single alert email, race-safe across overlapping scans) and
--      deletes it once the fingerprint is no longer active (its dead letters
--      were resolved). A fingerprint that resolves and later recurs has no
--      row, so it correctly re-alerts as a fresh incident — without re-alerting
--      on every scan just because the in-app notification was marked read.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS alerted_at timestamptz;

CREATE TABLE IF NOT EXISTS notification_active_errors (
  workspace_id     text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  fingerprint      text NOT NULL,
  reason           text NOT NULL,
  first_alerted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, fingerprint)
);
