-- Billing and free-tier quota now count accepted inbound events only.
-- Keep delivery_tasks for operational analytics, but exclude it from the
-- generated total consumed by plan gates, alerts, and admin billing views.
ALTER TABLE workspace_usage_period
  DROP COLUMN total_tasks;

ALTER TABLE workspace_usage_period
  ADD COLUMN total_tasks bigint GENERATED ALWAYS AS (ingest_tasks) STORED;
