-- One-click incident fix from the Inbox. Records when an operator asked Axel
-- to repair and replay an incident's failed deliveries, so a healthy check
-- can close the incident at once instead of waiting for the 15-minute
-- sustained-recovery window.
ALTER TABLE pipeline_incidents ADD COLUMN IF NOT EXISTS fix_requested_at timestamptz;
