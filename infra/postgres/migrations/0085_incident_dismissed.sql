-- "Ignore and close" from the Inbox. A dismissed incident stays open for the
-- monitor (it still resolves on sustained recovery and a later relapse opens
-- a fresh incident), but it leaves the Inbox and sends no more reminder or
-- recovery email until an operator brings it back.
ALTER TABLE pipeline_incidents ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;
