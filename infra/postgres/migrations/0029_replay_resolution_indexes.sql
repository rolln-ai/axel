-- Speed up incident-scale replay queueing and dashboard resolution checks.

CREATE INDEX IF NOT EXISTS dead_letters_workspace_source_reason_event_route_idx
  ON dead_letters (workspace_id, source_id, reason, event_id, route_id, errored_at);

CREATE INDEX IF NOT EXISTS replay_requests_resolution_lookup_idx
  ON replay_requests (workspace_id, event_id, route_id, state, requested_at, finished_at);
