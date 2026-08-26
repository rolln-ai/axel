import "server-only";

import { db } from "./db";
import { clickhouse, hasClickhouseUrl } from "./clickhouse";
import { prefixedId } from "./ids";
import { writeAudit } from "./audit";

/**
 * AXE-66 v2 — async backfill jobs.
 *
 * The dashboard inserts a single `backfill_jobs` row when an operator wants
 * to flush historical events into a route. The delivery-service worker
 * (apps/delivery-service/src/backfill-job-worker.ts) paginates ClickHouse
 * one window at a time and feeds `replay_requests` in throttled chunks —
 * never holding more than `max_inflight_replays` pending rows for a single
 * job at once.
 *
 * This replaces the v1 in-process helper (`backfill.ts`) which capped at
 * 10k events. The job model handles arbitrary sizes because the work is
 * bounded by the router's actual delivery rate, not by what fits in one
 * HTTP request.
 */

export interface CreateBackfillJobRequest {
  workspaceId: string;
  routeId: string;
  sourceId: string;
  since: Date;
  until: Date;
  requestedByUserId: string;
  /** Optional throttle override. Defaults to 1000. */
  maxInflightReplays?: number;
}

export interface BackfillJobSummary {
  id: string;
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  total_estimated: number | null;
  enqueued: number;
  since: string;
  until: string;
  requested_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
}

/**
 * Cheap COUNT() against the ClickHouse `events` table. Used by the dashboard
 * to preview the size of a backfill before the operator commits. Returns 0
 * when ClickHouse isn't configured rather than throwing — the UI should
 * surface "couldn't preview" but still let them queue the job.
 */
export async function previewBackfillCount(
  workspaceId: string,
  sourceId: string,
  since: Date,
  until: Date,
): Promise<number> {
  if (!hasClickhouseUrl()) return 0;
  const result = await clickhouse().query<{ n: string }>(
    `SELECT count() AS n
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND source_id = {source_id:String}
        AND received_at >= parseDateTime64BestEffort({since:String}, 3)
        AND received_at <  parseDateTime64BestEffort({until:String}, 3)
        AND is_test = 0`,
    {
      workspace_id: workspaceId,
      source_id: sourceId,
      since: toClickhouseDateTime(since),
      until: toClickhouseDateTime(until),
    },
  );
  return Number.parseInt(result.rows[0]?.n ?? "0", 10);
}

function toClickhouseDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

/**
 * Insert a new `backfill_jobs` row in `pending` state. The delivery-service
 * worker picks it up on its next tick. `total_estimated` is filled from the
 * ClickHouse preview so the UI can show progress as a percentage.
 */
export async function createBackfillJob(
  req: CreateBackfillJobRequest,
): Promise<{ id: string; total_estimated: number }> {
  if (req.until.getTime() <= req.since.getTime()) {
    throw new Error("backfill_window_invalid");
  }
  // Preview is best-effort — if ClickHouse hiccups we still queue the job
  // and let the worker discover the size as it paginates.
  let totalEstimated = 0;
  try {
    totalEstimated = await previewBackfillCount(
      req.workspaceId,
      req.sourceId,
      req.since,
      req.until,
    );
  } catch {
    totalEstimated = 0;
  }

  const id = prefixedId("bfj");
  await db().query(
    `INSERT INTO backfill_jobs
       (id, workspace_id, route_id, source_id, since, until, state,
        total_estimated, max_inflight_replays, requested_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, $9)`,
    [
      id,
      req.workspaceId,
      req.routeId,
      req.sourceId,
      req.since.toISOString(),
      req.until.toISOString(),
      totalEstimated > 0 ? totalEstimated : null,
      req.maxInflightReplays ?? 1000,
      req.requestedByUserId,
    ],
  );

  await writeAudit(db(), {
    workspaceId: req.workspaceId,
    actorUserId: req.requestedByUserId,
    action: "route.backfill_job.queued",
    targetType: "route",
    targetId: req.routeId,
    metadata: {
      backfill_job_id: id,
      source_id: req.sourceId,
      since: req.since.toISOString(),
      until: req.until.toISOString(),
      total_estimated: totalEstimated,
    },
  });

  return { id, total_estimated: totalEstimated };
}

/**
 * Mark a job as cancelled. The worker checks job state between each batch
 * and bails when it sees `cancelled`. Already-enqueued replay_requests
 * are NOT rolled back — they'll drain through the router normally. That's
 * intentional: the operator may want partial progress preserved, and
 * un-doing in-flight deliveries is operationally hairy.
 */
export async function cancelBackfillJob(
  workspaceId: string,
  jobId: string,
  cancelledByUserId: string,
): Promise<boolean> {
  const result = await db().query(
    `UPDATE backfill_jobs
        SET state = 'cancelled',
            finished_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND state IN ('pending', 'running')`,
    [jobId, workspaceId],
  );
  if ((result.rowCount ?? 0) === 0) return false;

  await writeAudit(db(), {
    workspaceId,
    actorUserId: cancelledByUserId,
    action: "route.backfill_job.cancelled",
    targetType: "backfill_job",
    targetId: jobId,
    metadata: {},
  });
  return true;
}

/**
 * Return the most recent active (`pending`/`running`) backfill job for a
 * route, plus the count of pending replays it has in flight. NULL when no
 * active job exists — that's the common case after a backfill completes.
 *
 * The UI uses this to show "Backfill in progress — 42% (42,000 / 100,000)"
 * on the route detail page.
 */
export async function getActiveBackfillJob(
  workspaceId: string,
  routeId: string,
): Promise<
  | (BackfillJobSummary & { pending_replays: number })
  | null
> {
  const jobResult = await db().query<BackfillJobSummary>(
    `SELECT id, state, total_estimated, enqueued,
            since::text AS since, until::text AS until,
            requested_at::text AS requested_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            error_message
       FROM backfill_jobs
      WHERE workspace_id = $1
        AND route_id = $2
        AND state IN ('pending', 'running')
      ORDER BY requested_at DESC
      LIMIT 1`,
    [workspaceId, routeId],
  );
  const job = jobResult.rows[0];
  if (!job) return null;

  const pendingResult = await db().query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM replay_requests
      WHERE backfill_job_id = $1
        AND state = 'pending'`,
    [job.id],
  );
  return {
    ...job,
    pending_replays: Number.parseInt(pendingResult.rows[0]?.n ?? "0", 10),
  };
}

/**
 * A single job by id, in any state. `getActiveBackfillJob` returns null once a
 * job finishes, which makes it useless for reporting a result — first-run setup
 * needs to poll one specific job and then show what it actually moved.
 */
export async function getBackfillJobById(
  workspaceId: string,
  jobId: string,
): Promise<BackfillJobSummary | null> {
  const result = await db().query<BackfillJobSummary>(
    `SELECT id, state, total_estimated, enqueued,
            since::text AS since, until::text AS until,
            requested_at::text AS requested_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            error_message
       FROM backfill_jobs
      WHERE workspace_id = $1
        AND id = $2
      LIMIT 1`,
    [workspaceId, jobId],
  );
  return result.rows[0] ?? null;
}

/**
 * How many of a job's replays have actually been delivered (as opposed to
 * merely enqueued). `enqueued` counts rows handed to the router; this counts
 * the ones it has finished with, so the UI can say "synced N" truthfully.
 */
export async function countBackfillDelivered(jobId: string): Promise<number> {
  const result = await db().query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM replay_requests
      WHERE backfill_job_id = $1
        AND state = 'done'`,
    [jobId],
  );
  return Number.parseInt(result.rows[0]?.n ?? "0", 10);
}

/**
 * Delivered AND failed counts for a job, plus one representative failure
 * message. Counting only successes leaves a UI spinning forever when every
 * replay is dead-lettering (a table the delivery path can't write to, an
 * unreachable database) — the failures have to be visible to stop.
 */
export async function countBackfillOutcomes(jobId: string): Promise<{
  delivered: number;
  failed: number;
  failureMessage: string | null;
}> {
  const result = await db().query<{
    delivered: string;
    failed: string;
    failure_message: string | null;
  }>(
    `SELECT count(*) FILTER (WHERE state = 'done')::text   AS delivered,
            count(*) FILTER (WHERE state = 'failed')::text AS failed,
            max(error_message) FILTER (WHERE state = 'failed') AS failure_message
       FROM replay_requests
      WHERE backfill_job_id = $1`,
    [jobId],
  );
  const row = result.rows[0];
  return {
    delivered: Number.parseInt(row?.delivered ?? "0", 10),
    failed: Number.parseInt(row?.failed ?? "0", 10),
    failureMessage: row?.failure_message ?? null,
  };
}

/**
 * List the N most recent backfill jobs for a route, regardless of state.
 * Used by the route detail page's "history" disclosure.
 */
export async function listRecentBackfillJobs(
  workspaceId: string,
  routeId: string,
  limit: number = 5,
): Promise<BackfillJobSummary[]> {
  const result = await db().query<BackfillJobSummary>(
    `SELECT id, state, total_estimated, enqueued,
            since::text AS since, until::text AS until,
            requested_at::text AS requested_at,
            started_at::text AS started_at,
            finished_at::text AS finished_at,
            error_message
       FROM backfill_jobs
      WHERE workspace_id = $1
        AND route_id = $2
      ORDER BY requested_at DESC
      LIMIT $3`,
    [workspaceId, routeId, limit],
  );
  return result.rows;
}
