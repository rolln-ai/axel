-- Migration 0063: one-digest-per-recipient-per-day claim.
--
-- The daily digest cron (lib/data-contracts/email-digest.ts) read a rolling
-- 24h window and sent, stamping nothing. A Vercel retry, a schedule-boundary
-- double fire, or an operator re-POSTing the route with the ops token mailed
-- every opted-in member a second copy of the same digest.
--
-- A row here is the claim to send one recipient's digest for one UTC day. The
-- job inserts with ON CONFLICT DO NOTHING RETURNING before it sends: the
-- invocation whose insert RETURNs owns the send, and anyone else skips. The
-- claim is deleted again when the send fails, so a failed digest can still go
-- out on a later run that day.
--
-- Same shape as the billing_events journal — a PK is the idempotency.

CREATE TABLE IF NOT EXISTS digest_sends (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest_date  date NOT NULL,
  sent_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, digest_date)
);

-- Supports the job's own prune of rows past the retention floor.
CREATE INDEX IF NOT EXISTS digest_sends_date_idx ON digest_sends (digest_date);
