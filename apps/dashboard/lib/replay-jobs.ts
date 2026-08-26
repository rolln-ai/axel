import "server-only";

import { cache } from "react";
import { db, type Queryable } from "./db";
import { prefixedId } from "./ids";

/**
 * Tracked "replay all unresolved" jobs (migration 0050).
 *
 * The "Replay all N unresolved" button on /deliveries used to bulk-insert up
 * to N `replay_requests` rows in one transaction, write a single audit row,
 * and return an ephemeral toast — no durable progress object an operator
 * could watch and no inbox feedback when the batch finished.
 *
 * Each bulk-replay click now creates one `replay_jobs` row (this module,
 * mirroring `backfill-jobs.ts`). Every `replay_request` it queues is tagged
 * with that job's id via `replay_requests.replay_job_id`, so the dashboard
 * can render live progress (a GROUP BY over `replay_requests.state`) and the
 * delivery-service worker can detect completion and emit a single
 * `replay_job_complete` notification.
 *
 * `succeeded_count`/`failed_count` are denormalized on the job so completion
 * detection and the terminal notification stay cheap; the live UI prefers the
 * GROUP BY counts and the worker recomputes the authoritative numbers in its
 * atomic finish UPDATE.
 */

export type ReplayJobState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ReplayJobSummary {
  id: string;
  state: ReplayJobState;
  reason: string;
  reason_filter: string | null;
  total: number;
  succeeded_count: number;
  failed_count: number;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

export interface ActiveReplayJob extends ReplayJobSummary {
  // Live, computed from replay_requests grouped by state for this job id.
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  // Convenience: pending + in_progress.
  remaining: number;
}

export interface CreateReplayJobRequest {
  workspaceId: string;
  requestedByUserId: string;
  reason: string;
  reasonFilter: string | null;
  /** Number of replay_requests this job will track. */
  total: number;
}

/**
 * Insert a `replay_jobs` row in `pending` state. The caller is responsible for
 * tagging the matching `replay_requests` rows with the returned id (within the
 * same transaction) so the FK is satisfied — pass that transaction's client as
 * `client` so the INSERT precedes the tagging UPDATE.
 *
 * Returns the pre-generated id (`prefixedId("rpyjob")`). Mirrors
 * `createBackfillJob` but takes an optional `Queryable` so it can run inside an
 * existing transaction.
 */
export async function createReplayJob(
  req: CreateReplayJobRequest,
  client: Queryable = db(),
): Promise<{ id: string }> {
  const id = prefixedId("rpyjob");
  await client.query(
    `INSERT INTO replay_jobs
       (id, workspace_id, requested_by_user_id, reason, reason_filter, total, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [id, req.workspaceId, req.requestedByUserId, req.reason, req.reasonFilter, req.total],
  );
  return { id };
}

/**
 * Most-recent active (`pending`/`running`) replay job for a workspace, plus
 * live per-state counts from `replay_requests`. NULL when no active job
 * exists — the common case once a batch finishes. Keyed on `workspace_id`
 * only (unlike backfill, which is per-route); at most one is shown
 * (`ORDER BY requested_at DESC LIMIT 1`).
 *
 * Live numbers come from a GROUP BY over `replay_requests.state`;
 * `succeeded_count`/`failed_count` on the row are the worker's denormalized
 * totals used for the terminal notification.
 */
export async function getActiveReplayJob(
  workspaceId: string,
  client: Queryable = db(),
): Promise<ActiveReplayJob | null> {
  const jobResult = await client.query<ReplayJobSummary>(
    `SELECT id, state, reason, reason_filter,
            total::int AS total,
            succeeded_count, failed_count,
            requested_at::text AS requested_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            error_message
       FROM replay_jobs
      WHERE workspace_id = $1
        AND state IN ('pending', 'running')
      ORDER BY requested_at DESC
      LIMIT 1`,
    [workspaceId],
  );
  const job = jobResult.rows[0];
  if (!job) return null;

  return hydrateReplayJob(job, client);
}

/**
 * Most recent replay job that contains requests for one investigation group.
 *
 * Unlike the workspace banner, the investigation page keeps a recently
 * completed job visible for 15 minutes. That gives the final 100% state time
 * to land in the UI instead of disappearing on the refresh that observes job
 * completion.
 */
export async function getInvestigationReplayJob(
  workspaceId: string,
  sourceId: string,
  failureReason: string,
  client: Queryable = db(),
): Promise<ActiveReplayJob | null> {
  const jobResult = await client.query<ReplayJobSummary>(
    `SELECT j.id, j.state, j.reason, j.reason_filter,
            j.total::int AS total,
            j.succeeded_count, j.failed_count,
            j.requested_at::text AS requested_at,
            j.started_at::text AS started_at,
            j.finished_at::text AS finished_at,
            j.error_message
       FROM replay_jobs j
      WHERE j.workspace_id = $1
        AND (
          j.state IN ('pending', 'running')
          OR j.finished_at > now() - interval '15 minutes'
        )
        AND EXISTS (
          SELECT 1
            FROM replay_requests rr
           WHERE rr.replay_job_id = j.id
             AND rr.source_id = $2
             AND rr.failure_reason = $3
        )
      ORDER BY j.requested_at DESC
      LIMIT 1`,
    [workspaceId, sourceId, failureReason],
  );
  const job = jobResult.rows[0];
  if (!job) return null;

  return hydrateReplayJob(job, client);
}

async function hydrateReplayJob(
  job: ReplayJobSummary,
  client: Queryable,
): Promise<ActiveReplayJob> {
  // pg returns count(*) as a STRING; normalize each bucket.
  const counts = await client.query<{ state: string; n: string }>(
    `SELECT state, count(*)::text AS n
       FROM replay_requests
      WHERE replay_job_id = $1
      GROUP BY state`,
    [job.id],
  );
  const by: Record<string, number> = {};
  for (const r of counts.rows) by[r.state] = Number.parseInt(r.n, 10);
  const pending = by.pending ?? 0;
  const in_progress = by.in_progress ?? 0;
  return {
    ...job,
    // total may arrive as a string (bigint); normalize.
    total: Number(job.total),
    succeeded_count: Number(job.succeeded_count),
    failed_count: Number(job.failed_count),
    pending,
    in_progress,
    done: by.done ?? 0,
    failed: by.failed ?? 0,
    remaining: pending + in_progress,
  };
}

export interface ReplayJobProgress {
  total: number;
  /** done + failed (terminal). */
  settled: number;
  /** pending + in_progress. */
  remaining: number;
  succeeded: number;
  failed: number;
  /** Integer 0–100; 0 when total is unknown. */
  percent: number;
}

/**
 * Derive a render-ready progress shape from an {@link ActiveReplayJob}. Prefers
 * the live GROUP BY counts; falls back to the job's own `total` when the
 * grouped counts haven't caught up yet. Pure — safe to reuse in the server
 * component and in tests.
 */
export function replayJobProgress(job: ActiveReplayJob): ReplayJobProgress {
  const settled = job.done + job.failed;
  const total = job.total || settled + job.remaining;
  const percent = total > 0 ? Math.round((settled / total) * 100) : 0;
  return {
    total,
    settled,
    remaining: job.remaining,
    succeeded: job.done,
    failed: job.failed,
    percent,
  };
}

/**
 * Per-request memoized read of the active replay job. The server component
 * renders on both /deliveries and /inbox; wrapping the read in `cache()` dedupes
 * the two indexed point queries within a single render pass (mirrors the
 * `react cache()` usage elsewhere in the dashboard).
 */
export const getActiveReplayJobCached = cache(
  (workspaceId: string): Promise<ActiveReplayJob | null> => getActiveReplayJob(workspaceId),
);
