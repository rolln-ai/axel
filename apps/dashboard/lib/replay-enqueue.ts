import "server-only";
import { updateTag } from "next/cache";
import { writeAudit } from "./audit";
import type { Queryable } from "./db";
import { prefixedId } from "./ids";
import { cacheTags } from "./repositories";
import { createReplayJob } from "./replay-jobs";

/**
 * Shared tail for EVERY replay enqueue in the dashboard + public API.
 *
 * Eight call sites used to hand-roll the same sequence — insert into
 * `replay_requests` with an in-flight dedupe guard, an active-mute check, an
 * audit row, and cache-tag busting — and the copies drifted (the v1 REST
 * endpoint shipped without the dedupe guard; id generation split between
 * `prefixedId("rpy")` and a SQL `gen_random_uuid()` literal). This module
 * unifies the tail while leaving each caller's CANDIDATE-SELECTION SQL in
 * place, because that part genuinely differs per entry point (single dead
 * letter, id batch, whole-workspace CTE, fingerprint resolution, …).
 *
 * Contract: `candidates.sql` is a SELECT yielding one row per replay
 * candidate with the columns
 *
 *   event_id, source_id, r2_key, scope, route_id, destination_id,
 *   failure_reason, fingerprint
 *
 * (cast NULLs to ::text where a column doesn't apply; a NULL fingerprint
 * never matches a mute, so those rows always pass the mute check).
 *
 * The tail then, atomically on the caller's `client` (pass the transaction
 * client to stay inside the caller's transaction):
 *
 *   1. evaluates each candidate against active `dead_letter_mutes` and
 *      pending/in-progress `replay_requests` (the in-flight dedupe guard);
 *   2. inserts the eligible rows with app-generated `prefixedId("rpy")` ids
 *      — the ONE id scheme, everywhere;
 *   3. optionally creates a tracking `replay_jobs` row and stamps the
 *      inserted requests with its id;
 *   4. optionally writes ONE canonical audit row (metadata is merged with
 *      `{ queued }` and, when a job was created, `{ replay_job_id }`).
 *
 * Cache-tag busting stays a separate explicit call (`bustReplayTags`)
 * because `updateTag` is a server-action-only API: route handlers (the REST
 * endpoint) must not call it, and transactional callers should bust after
 * commit.
 */
export interface ReplayCandidates {
  /**
   * SELECT yielding the candidate columns documented above. Parameters are
   * `$1..$N` referring to `params`; the tail appends its own parameter after
   * yours, so never hard-code `$N+1`.
   */
  sql: string;
  params: unknown[];
}

export interface EnqueueReplaysAudit {
  action: string;
  /** Defaults to "replay_request". */
  targetType?: string;
  /**
   * Defaults to the single inserted replay id when exactly one row queued,
   * else the queued count as text (the pre-existing bulk convention).
   */
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface EnqueueReplaysOptions {
  workspaceId: string;
  /** Null for non-user actors (API keys). */
  actorUserId: string | null;
  /** `replay_requests.reason` for the inserted rows. */
  reason: string | null;
  candidates: ReplayCandidates;
  /** Written only when at least one row queued. */
  audit?: EnqueueReplaysAudit;
  /**
   * Create a tracking `replay_jobs` row (when at least one row queued) and
   * stamp the inserted requests with its id. Requires a user actor.
   */
  job?: { reasonFilter: string | null };
}

export interface EnqueueReplaysResult {
  /** Rows actually inserted. */
  queued: number;
  /** Candidates withheld because their fingerprint is actively muted (counted regardless of in-flight state). */
  mutedSkipped: number;
  /** Non-muted candidates withheld because the same replay is already pending/in progress. */
  inFlightSkipped: number;
  replayIds: string[];
  jobId: string | null;
}

interface CandidateRow {
  event_id: string;
  source_id: string;
  r2_key: string;
  scope: string;
  route_id: string | null;
  destination_id: string | null;
  failure_reason: string | null;
  is_muted: boolean;
  is_in_flight: boolean;
}

export async function enqueueReplays(
  client: Queryable,
  opts: EnqueueReplaysOptions,
): Promise<EnqueueReplaysResult> {
  const ws = `$${opts.candidates.params.length + 1}`;
  const evaluated = await client.query<CandidateRow>(
    `WITH candidates AS (${opts.candidates.sql})
     SELECT c.event_id, c.source_id, c.r2_key, c.scope, c.route_id, c.destination_id,
            c.failure_reason,
            EXISTS (
              -- Respect an active mute on the candidate's fingerprint — an
              -- operator silenced it on purpose; replaying re-floods the queue.
              SELECT 1 FROM dead_letter_mutes m
               WHERE m.workspace_id = ${ws}
                 AND m.fingerprint = c.fingerprint
                 AND (m.until IS NULL OR m.until > now())
            ) AS is_muted,
            EXISTS (
              -- In-flight dedupe: the EXACT same replay (scope + route +
              -- destination) already pending/in progress. Double-clicks and
              -- repeated API POSTs must not queue duplicates.
              SELECT 1 FROM replay_requests rr
               WHERE rr.workspace_id = ${ws}
                 AND rr.event_id = c.event_id
                 AND rr.scope = c.scope
                 AND rr.route_id IS NOT DISTINCT FROM c.route_id
                 AND rr.destination_id IS NOT DISTINCT FROM c.destination_id
                 AND rr.state IN ('pending', 'in_progress')
            ) AS is_in_flight
       FROM candidates c`,
    [...opts.candidates.params, opts.workspaceId],
  );

  const mutedSkipped = evaluated.rows.filter((r) => r.is_muted).length;
  const insertable = evaluated.rows.filter((r) => !r.is_muted && !r.is_in_flight);
  const inFlightSkipped = evaluated.rows.length - mutedSkipped - insertable.length;

  if (insertable.length === 0) {
    return { queued: 0, mutedSkipped, inFlightSkipped, replayIds: [], jobId: null };
  }

  const replayIds = insertable.map(() => prefixedId("rpy"));
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO replay_requests
       (id, workspace_id, event_id, source_id, r2_key, scope, route_id, destination_id, state, reason, failure_reason, requested_by_user_id)
     SELECT v.id, $1, v.event_id, v.source_id, v.r2_key, v.scope, v.route_id, v.destination_id, 'pending', $2, v.failure_reason, $3
       FROM UNNEST($4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
            AS v(id, event_id, source_id, r2_key, scope, route_id, destination_id, failure_reason)
     RETURNING id`,
    [
      opts.workspaceId,
      opts.reason,
      opts.actorUserId,
      replayIds,
      insertable.map((r) => r.event_id),
      insertable.map((r) => r.source_id),
      insertable.map((r) => r.r2_key),
      insertable.map((r) => r.scope),
      insertable.map((r) => r.route_id),
      insertable.map((r) => r.destination_id),
      insertable.map((r) => r.failure_reason),
    ],
  );
  const queued = inserted.rowCount ?? replayIds.length;

  // Tracking job — inserted BEFORE the tagging UPDATE so the FK is satisfied;
  // both run on the caller's client, so a rollback discards job + replays
  // together.
  let jobId: string | null = null;
  if (opts.job && queued > 0) {
    if (!opts.actorUserId) throw new Error("enqueueReplays: a tracking job requires a user actor");
    const created = await createReplayJob(
      {
        workspaceId: opts.workspaceId,
        requestedByUserId: opts.actorUserId,
        reason: opts.reason ?? "replay",
        reasonFilter: opts.job.reasonFilter,
        total: queued,
      },
      client,
    );
    jobId = created.id;
    await client.query(
      `UPDATE replay_requests SET replay_job_id = $1 WHERE id = ANY($2::text[])`,
      [jobId, replayIds],
    );
  }

  if (opts.audit && queued > 0) {
    await writeAudit(client, {
      workspaceId: opts.workspaceId,
      actorUserId: opts.actorUserId,
      action: opts.audit.action,
      targetType: opts.audit.targetType ?? "replay_request",
      targetId: opts.audit.targetId ?? (queued === 1 ? replayIds[0]! : String(queued)),
      metadata: {
        ...(opts.audit.metadata ?? {}),
        queued,
        ...(jobId ? { replay_job_id: jobId } : {}),
      },
    });
  }

  return { queued, mutedSkipped, inFlightSkipped, replayIds, jobId };
}

/**
 * Bust the cached replay/dead-letter readers (plus the replay-jobs list when
 * a tracking job was created) so /deliveries and the dashboard Activity panel
 * pick up the new pending rows. Server actions only — `updateTag` cannot run
 * in route handlers, which is why this is not folded into `enqueueReplays`.
 */
export function bustReplayTags(workspaceId: string, opts: { jobs?: boolean } = {}): void {
  updateTag(cacheTags.replays(workspaceId));
  updateTag(cacheTags.deadLetters(workspaceId));
  if (opts.jobs) updateTag(cacheTags.replayJobs(workspaceId));
}
