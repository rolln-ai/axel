// Pure helpers for the tracked "replay all unresolved" completion path.
//
// The race-critical finish UPDATE + notification INSERT live in server.ts
// (closing over the shared pg pool). The *decisions* those code paths make —
// how a completed job's notification should read, and whether a notification
// INSERT error is the intended dedup outcome — are pure and therefore unit
// tested here. Keeping them in this side-effect-free module also means the
// worker entrypoint (server.ts) does not have to be imported to test them.

export interface ReplayJobCompletionNotice {
  /** notifications.severity — only the CHECK-valid 'info'/'warning' are used. */
  severity: "info" | "warning";
  /** notifications.title shown in the inbox. */
  title: string;
}

/**
 * Presentation for the single `replay_job_complete` notification emitted when a
 * tracked replay job finishes. `failed > 0` raises the severity to 'warning'
 * and appends a "still failing" clause, because "replayed" != "resolved": a
 * replay that fails again leaves its dead_letter unresolved.
 */
export function replayJobCompletionNotice(
  succeeded: number,
  failed: number,
): ReplayJobCompletionNotice {
  const severity: "info" | "warning" = failed > 0 ? "warning" : "info";
  const title =
    failed > 0
      ? `Replay finished: ${succeeded.toLocaleString("en-US")} succeeded, ${failed.toLocaleString("en-US")} still failing`
      : `Replay finished: ${succeeded.toLocaleString("en-US")} succeeded`;
  return { severity, title };
}

/** Stable dedup key for a job's completion notification (one per job, ever). */
export function replayJobCompletionDedupKey(jobId: string): string {
  return `replay_job_complete:${jobId}`;
}

/**
 * True when a notification INSERT error is the intended dedup outcome — a
 * concurrent racer (or a re-run after the row already landed) trips the
 * partial unique index `notifications_active_dedup_idx` (Postgres 23505), which
 * must be swallowed rather than logged as a failure.
 */
export function isDuplicateNotificationError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true;
  const messageText = (err as { message?: unknown }).message;
  return typeof messageText === "string" && /notifications_active_dedup_idx/.test(messageText);
}
