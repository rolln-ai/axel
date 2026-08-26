/**
 * Recover the `replay_requests` id from a replayed event id.
 *
 * The router tags a replayed event as `<original_event_id>#<replay_id>` (see
 * `replayEventId` in @axel/router) so a replay's delivery is distinguishable
 * from the original. The delivery handler parses it back out to write the
 * outcome onto the replay row.
 *
 * TWO id prefixes are in play and both must be recognised:
 *
 *   rpy_  dashboard-initiated replays — prefixedId("rpy") in actions.ts
 *   rpl_  backfill-job replays        — generateReplayId in backfill-job-worker.ts
 *
 * This used to match `rpy_` only, which orphaned every backfill replay: the
 * delivery outcome (success OR dead) was dropped, the row stayed `in_progress`
 * forever, and the 10-minute stale reclaim re-delivered the same event on a
 * loop. Seen in production as a backfill stuck at 0 delivered with the same
 * dead letter recurring exactly every 10 minutes.
 *
 * Lives in its own module because server.ts boots a listener on import and so
 * can't be pulled into a unit test.
 */
const REPLAY_ID_PATTERN = /^rp[yl]_[A-Za-z0-9_-]+$/;

export function replayRequestIdFromEventId(eventId: string): string | null {
  const index = Math.max(eventId.lastIndexOf("#rpy_"), eventId.lastIndexOf("#rpl_"));
  if (index === -1) return null;
  const replayId = eventId.slice(index + 1);
  return REPLAY_ID_PATTERN.test(replayId) ? replayId : null;
}
