-- Large workspace teardowns delete delivery idempotency rows by workspace in
-- bounded batches. The table previously had only its primary key and expiry
-- index, forcing a full scan for every batch (1.1M rows in the production
-- incident that motivated this migration).
--
-- CONCURRENTLY keeps delivery writes available while the production index is
-- built. The migration runner does not wrap files in a transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS delivery_idempotency_workspace_idx
  ON delivery_idempotency (workspace_id);
