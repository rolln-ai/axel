-- Dashboard Activity needs to match active replay rows back to unresolved
-- dead_letters by (workspace_id, event_id, route_id) without scanning the
-- incident backlog.

CREATE INDEX IF NOT EXISTS dead_letters_workspace_event_route_reason_idx
  ON dead_letters (workspace_id, event_id, route_id, reason, errored_at);

CREATE INDEX IF NOT EXISTS replay_requests_workspace_state_event_route_idx
  ON replay_requests (workspace_id, state, event_id, route_id, requested_at);

CREATE INDEX IF NOT EXISTS dead_letters_workspace_event_route_key_reason_idx
  ON dead_letters (workspace_id, event_id, COALESCE(route_id, ''), reason, errored_at);

CREATE INDEX IF NOT EXISTS replay_requests_workspace_state_event_route_key_idx
  ON replay_requests (workspace_id, state, event_id, COALESCE(route_id, ''), requested_at);
