-- A pull stream that reaches its per-run page/record safety cap is incomplete
-- but healthy: its continuation token is persisted and the next run resumes it.
-- Store that state explicitly instead of presenting a capped run as success.

BEGIN;

ALTER TABLE pull_source_stream_state
  ADD COLUMN IF NOT EXISTS pending_high_watermark jsonb;

ALTER TABLE pull_sync_runs
  DROP CONSTRAINT IF EXISTS pull_sync_runs_status_check;

ALTER TABLE pull_sync_runs
  ADD CONSTRAINT pull_sync_runs_status_check
  CHECK (status IN ('running', 'success', 'partial', 'failed'));

COMMIT;
