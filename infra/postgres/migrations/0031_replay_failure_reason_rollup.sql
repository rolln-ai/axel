-- Denormalize the dead-letter failure reason onto replay requests so the
-- dashboard can show queued/running replay counts without joining the active
-- replay queue back through the full dead_letters backlog on every render.

ALTER TABLE replay_requests
  ADD COLUMN IF NOT EXISTS failure_reason text;

UPDATE replay_requests rr
   SET failure_reason = dl.reason
  FROM dead_letters dl
 WHERE rr.failure_reason IS NULL
   AND rr.workspace_id = dl.workspace_id
   AND rr.event_id = dl.event_id
   AND rr.scope = 'route'
   AND rr.route_id IS NOT DISTINCT FROM dl.route_id;

CREATE INDEX IF NOT EXISTS replay_requests_active_failure_reason_idx
  ON replay_requests (workspace_id, failure_reason, state)
  WHERE scope = 'route'
    AND state IN ('pending', 'in_progress')
    AND failure_reason IS NOT NULL;
