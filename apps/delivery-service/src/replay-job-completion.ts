// Shared worker helper for the tracked "Replay all unresolved" job.
//
// Both terminal codepaths reach this module:
//   1. server.ts markReplayDeliveryOutcome — when a *delivery* queue message is
//      observed for a replayed event (the happy path: the replay enqueued a
//      delivery and the delivery service ran it to success/dead).
//   2. replay-worker.ts createPgReplayStore markDone/markFailed — the
//      DISPATCH-failed path, where the replay never enqueued a delivery (R2
//      payload missing, route deleted, processQueueMessage threw) so no
//      delivery message ever lands in (1).
//
// Keeping the race-critical finish UPDATE + notification INSERT in ONE place
// means both codepaths are byte-for-byte identical: there is exactly one
// atomic finish-once statement, so a job can never be left "running" forever
// just because its last in-flight replay failed at dispatch.
//
// Everything here takes the pg pool as a parameter (rather than closing over a
// module-level pool) so it can be unit-tested with a fake pool — see
// test/replay-job-completion.test.ts.

import type { Pool } from "pg";
import { withPgRetry } from "@axel/observability";
import {
  isDuplicateNotificationError,
  replayJobCompletionDedupKey,
  replayJobCompletionNotice,
} from "./replay-job-completion-helpers.js";

// A minimal structural type so the helpers accept either a real pg Pool/Client
// or the fake pool used in tests, without importing pg internals at the call
// site. `Pool` satisfies this shape.
export interface ReplayJobQueryable {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
}

// Assert at the type boundary that pg.Pool satisfies ReplayJobQueryable.
export type ReplayJobPool = Pool & ReplayJobQueryable;

/**
 * Stamp the job 'running' the first time any of its requests changes state, and
 * bump the denormalized succeeded/failed counter for cheap live reads.
 *
 * The 'running' stamp is also done on the claim path in replay-worker.ts; the
 * `WHERE state = 'pending'` guard makes both idempotent. The counter bump is
 * best-effort — the finish UPDATE RECOMPUTES authoritative counts from
 * replay_requests, so the incremental number is only ever a live-read hint and
 * is allowed to over-count under the documented failed->done flip.
 */
export async function bumpReplayJobCounter(
  pool: ReplayJobQueryable,
  jobId: string,
  outcome: "succeeded" | "failed",
): Promise<void> {
  await withPgRetry("replay-job-running", () =>
    pool.query(
      `UPDATE replay_jobs
          SET state = 'running',
              started_at = COALESCE(started_at, now())
        WHERE id = $1
          AND state = 'pending'`,
      [jobId],
    ),
  );
  await withPgRetry("replay-job-counter", () =>
    pool.query(
      `UPDATE replay_jobs
          SET succeeded_count = succeeded_count + CASE WHEN $2 = 'succeeded' THEN 1 ELSE 0 END,
              failed_count    = failed_count    + CASE WHEN $2 = 'failed'    THEN 1 ELSE 0 END
        WHERE id = $1`,
      [jobId, outcome],
    ),
  );
}

/**
 * Atomic finish-once: the WHERE clause (finished_at IS NULL AND NOT EXISTS any
 * pending/in_progress sibling) is a single statement across every
 * delivery-service replica and BOTH terminal codepaths — exactly one worker
 * gets rowCount > 0 and emits the completion notification.
 * succeeded_count/failed_count are RECOMPUTED from a FILTER GROUP BY over
 * replay_requests so the documented failed->done flip self-corrects any
 * over-count from the incremental bumps.
 */
export async function finishReplayJobIfComplete(
  pool: ReplayJobQueryable,
  jobId: string,
): Promise<void> {
  const finished = await withPgRetry("replay-job-finish", () =>
    pool.query<{ workspace_id: string; succeeded_count: number; failed_count: number }>(
      `UPDATE replay_jobs j
          SET state = 'done',
              finished_at = now(),
              succeeded_count = c.succeeded,
              failed_count    = c.failed
         FROM (
           SELECT
             count(*) FILTER (WHERE state = 'done')   AS succeeded,
             count(*) FILTER (WHERE state = 'failed') AS failed
             FROM replay_requests
            WHERE replay_job_id = $1
         ) c
        WHERE j.id = $1
          AND j.finished_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM replay_requests
             WHERE replay_job_id = $1
               AND state IN ('pending', 'in_progress')
          )
      RETURNING j.workspace_id, j.succeeded_count, j.failed_count`,
      [jobId],
    ),
  );
  // rowCount 0 => not yet complete OR another worker already finished it.
  if ((finished.rowCount ?? 0) === 0) return;
  const row = finished.rows[0];
  if (!row) return;
  await emitReplayJobCompleteNotification(
    pool,
    row.workspace_id,
    jobId,
    Number(row.succeeded_count),
    Number(row.failed_count),
  );
}

async function emitReplayJobCompleteNotification(
  pool: ReplayJobQueryable,
  workspaceId: string,
  jobId: string,
  succeeded: number,
  failed: number,
): Promise<void> {
  const { severity, title } = replayJobCompletionNotice(succeeded, failed);
  try {
    await pool.query(
      `INSERT INTO notifications (id, workspace_id, user_id, kind, severity, title, body_md, link_path, dedup_key, created_at)
       VALUES ($1, $2, NULL, 'replay_job_complete', $3, $4, NULL, '/deliveries', $5, now())`,
      [
        `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId,
        severity,
        title,
        replayJobCompletionDedupKey(jobId),
      ],
    );
  } catch (err) {
    // The partial unique index notifications_active_dedup_idx guarantees only
    // one active completion notification per job; a concurrent racer (or a
    // re-run after the row was already inserted) trips 23505, which is the
    // intended dedup outcome — swallow it. Any other error (e.g. the
    // notifications table missing on an older deploy) is logged but never
    // allowed to break delivery.
    if (isDuplicateNotificationError(err)) return;
    console.error("[replay-job] completion notification insert failed", err);
  }
}

/**
 * Best-effort terminal advance used by both codepaths: bump the live counter
 * then run the atomic finish. Counters/notifications are non-critical, so a
 * failure (e.g. replay_jobs/notifications table missing on an older deploy) is
 * logged but never allowed to break delivery or the replay batch.
 */
export async function advanceReplayJobOnTerminal(
  pool: ReplayJobQueryable,
  jobId: string,
  outcome: "succeeded" | "failed",
): Promise<void> {
  try {
    await bumpReplayJobCounter(pool, jobId, outcome);
    await finishReplayJobIfComplete(pool, jobId);
  } catch (err) {
    console.error("[replay-job] terminal advance failed", err);
  }
}
