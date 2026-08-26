-- Migration 0055: persist the per-page resume cursor for pull syncs.
--
-- The pull runner (packages/pull-connectors/src/runner.ts) checkpoints a
-- `resumePageCursor` after every fully-written page — the connector's page token
-- (Stripe `starting_after`, etc.) — so a mid-pageset crash resumes pagination
-- from the interrupted page instead of restarting. But PostgresPullStateStore
-- only persisted `cursor`, silently dropping resumePageCursor (no column), so the
-- resume was inoperative: every crashed sync restarted from page 1, re-ingesting
-- all prior pages (deduped downstream today, but wasteful and a latent gap for
-- descending-ordered connectors).
--
-- Nullable text — null/absent means "no pageset in flight" (clean incremental
-- boundary). Idempotent so it is safe against live DBs.

ALTER TABLE pull_source_stream_state
  ADD COLUMN IF NOT EXISTS resume_page_cursor text;
