/**
 * ReplayJobProgress — live progress row for the most-recent "Replay all N
 * unresolved" job in a workspace.
 *
 * Rendered in two places that share the same {@link getActiveReplayJobCached}
 * read (deduped per request via `react cache()`):
 *   - top of /deliveries — immediate feedback after the operator clicks
 *     "Replay all N unresolved" (the button lives there); and
 *   - the /inbox header — the operator's "a message in my inbox" mental model.
 *
 * Async SERVER component. Renders NOTHING when there is no active
 * ('pending'|'running') job, so it's safe to drop unconditionally into either
 * page. Dependency-light: a Badge, a div-based progress bar, and
 * {@link LocalTime}; matches the existing dashboard card look
 * (rounded-lg border bg-card).
 */
import {
  getActiveReplayJobCached,
  replayJobProgress,
} from "../../lib/replay-jobs";
import { ReplayJobProgressCard } from "./ReplayJobProgressCard";

export async function ReplayJobProgress({ workspaceId }: { workspaceId: string }) {
  const job = await getActiveReplayJobCached(workspaceId);
  if (!job) return null;

  const { total, settled, remaining, succeeded, failed, percent } = replayJobProgress(job);
  return (
    <ReplayJobProgressCard
      progress={{
        state: job.state,
        total,
        settled,
        remaining,
        succeeded,
        failed,
        percent,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
      }}
    />
  );
}
