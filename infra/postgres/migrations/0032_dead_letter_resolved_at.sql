-- Store resolution on the dead-letter row itself. Counting unresolved
-- failures by anti-joining replay history is slow during large replay
-- incidents, and it can stay stale when replay state is repaired out of band.

ALTER TABLE dead_letters
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS resolved_by_replay_id text;

UPDATE dead_letters dl
   SET resolved_at = rr.finished_at,
       resolved_by_replay_id = rr.id
  FROM replay_requests rr
 WHERE dl.resolved_at IS NULL
   AND rr.workspace_id = dl.workspace_id
   AND rr.event_id = dl.event_id
   AND rr.scope = 'route'
   AND rr.route_id IS NOT DISTINCT FROM dl.route_id
   AND rr.state = 'done'
   AND rr.finished_at IS NOT NULL
   AND rr.finished_at > dl.errored_at;

CREATE INDEX IF NOT EXISTS dead_letters_workspace_unresolved_time_idx
  ON dead_letters (workspace_id, errored_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS dead_letters_workspace_unresolved_reason_time_idx
  ON dead_letters (workspace_id, reason, errored_at DESC)
  WHERE resolved_at IS NULL;
