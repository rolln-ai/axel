"use server";

// Replay + dead-letter server actions.

import { db, withTransaction } from "./db";
import { requireSession } from "./session";
import { fetchPayloadForR2Key } from "./sample-payload";
import { withWorkspaceMutation } from "./with-mutation";
import { bustReplayTags, enqueueReplays } from "./replay-enqueue";
import { formValue } from "./form";
import type { ActionState } from "./action-data";

// --- Replay (re-run an event through the routing pipeline) -------------- //

export async function requestReplay(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ billing: "replay" }, async ({ workspaceId, actorUserId }) => {
    const deadLetterId = formValue(formData, "dead_letter_id");
    if (!deadLetterId) return { error: "Missing failed-delivery row reference." };

    const reason = formValue(formData, "reason") || null;

    let queued: number;
    let replayId: string | undefined;
    try {
      // Candidate: the single unresolved dead letter, scoped to the SPECIFIC
      // destination when the dead letter names one (migration 0049); only fall
      // back to whole-route replay for legacy/route-level failures. Replaying a
      // single failed destination must NOT re-fire the route's already-succeeded
      // ones. In-flight dedupe + mute check live in enqueueReplays.
      const result = await enqueueReplays(db(), {
        workspaceId,
        actorUserId,
        reason,
        candidates: {
          sql: `SELECT dl.event_id, dl.source_id, dl.r2_key,
                       CASE WHEN dl.destination_id IS NOT NULL THEN 'destination' ELSE 'route' END AS scope,
                       dl.route_id, dl.destination_id, dl.reason AS failure_reason, dl.fingerprint
                  FROM dead_letters dl
                 WHERE dl.id = $1::bigint AND dl.workspace_id = $2
                   AND dl.resolved_at IS NULL`,
          params: [deadLetterId, workspaceId],
        },
        audit: {
          action: "replay.requested",
          metadata: { dead_letter_id: deadLetterId, reason },
        },
      });
      queued = result.queued;
      replayId = result.replayIds[0];
    } catch {
      return { error: "Could not queue the replay request. Try again." };
    }
    if (!queued || !replayId) {
      return { error: "No replayable failure for that row — it may be resolved, already queued, or its fingerprint is muted." };
    }

    // Bust the cached replay + dead-letter readers so /deliveries and the
    // dashboard "Activity" panel pick up the new pending row without the user
    // having to hard-refresh. Both tags also flow into the dashboard metrics
    // cache (it tags itself with the dead-letter tag).
    bustReplayTags(workspaceId);

    return { notice: `Replay queued (${replayId}). Router will process within a minute.` };
  });
}

/**
 * Queue a replay for many dead-letter rows in one transaction. Used by the
 * bulk-replay UI on /deliveries. Caller passes `dead_letter_ids` as a
 * comma-separated string in the FormData (form-encoded arrays are clunky;
 * a CSV is fine since these are server-generated bigint ids with no commas).
 *
 * Each row generates a new replay_request with state='pending'. Rows that
 * don't belong to the caller's workspace are silently skipped — we report
 * the actual queued count rather than failing the whole batch on one bad id.
 */
export async function requestReplayBulk(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({ billing: "replay" }, async ({ workspaceId, actorUserId }) => {
    const idsRaw = formValue(formData, "dead_letter_ids");
    if (!idsRaw) return { error: "No events selected for replay." };
    const deadLetterIds = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[0-9]+$/.test(s));
    if (deadLetterIds.length === 0) return { error: "Replay selection was empty or invalid." };

    // Per-batch cap. The replay table is one row per dead letter, so 500 at a
    // time is plenty for an operator clicking "replay all" on a backlog page
    // and small enough to keep the transaction fast.
    const BATCH_CAP = 500;
    if (deadLetterIds.length > BATCH_CAP) {
      return { error: `Select at most ${BATCH_CAP} events at once.` };
    }

    const reason = formValue(formData, "reason") || "bulk_replay";
    let queued = 0;
    // Selected rows withheld solely because their fingerprint is muted (would
    // otherwise have queued). Reported distinctly so the skip isn't invisible.
    // enqueueReplays counts mutes regardless of in-flight state, so a muted DL
    // sharing (event_id, route_id) with a just-queued row is never silently
    // mis-bucketed into the generic skip note.
    let mutedSkipped = 0;
    try {
      await withTransaction(async (client) => {
        // Candidates: the selected rows that exist in THIS workspace and are
        // still unresolved (foreign/resolved ids simply drop out of the join).
        // The in-flight dedupe + mute anti-join + audit live in enqueueReplays.
        const result = await enqueueReplays(client, {
          workspaceId,
          actorUserId,
          reason,
          candidates: {
            sql: `SELECT dl.event_id, dl.source_id, dl.r2_key, 'route' AS scope,
                         dl.route_id, NULL::text AS destination_id, dl.reason AS failure_reason, dl.fingerprint
                    FROM dead_letters dl
                    JOIN UNNEST($1::bigint[]) AS x(dl_id) ON x.dl_id = dl.id
                   WHERE dl.workspace_id = $2
                     AND dl.resolved_at IS NULL`,
            params: [deadLetterIds, workspaceId],
          },
          audit: {
            // target_id holds the queued count for bulk (enqueueReplays default);
            // individual ids live in metadata.
            action: "replay.requested_bulk",
            metadata: { dead_letter_ids: deadLetterIds, reason },
          },
        });
        queued = result.queued;
        mutedSkipped = result.mutedSkipped;
      });
    } catch {
      return { error: "Could not queue the replay requests. Try again." };
    }

    if (queued === 0) {
      if (mutedSkipped > 0) {
        return {
          notice: `All ${mutedSkipped.toLocaleString("en-US")} selected event${mutedSkipped === 1 ? " is" : "s are"} muted — unmute to replay.`,
        };
      }
      return { error: "None of the selected events were found in this workspace." };
    }

    bustReplayTags(workspaceId);

    const skipped = deadLetterIds.length - queued;
    // Muted rows are part of `skipped` but reported on their own line; the rest
    // are resolved / in-flight / foreign.
    const otherSkipped = skipped - mutedSkipped;
    const skipNote = otherSkipped > 0 ? ` (${otherSkipped} skipped — already resolved, already in flight, or not in this workspace)` : "";
    const mutedNote = mutedSkipped > 0 ? ` ${mutedSkipped} muted (unmute to replay).` : "";
    return {
      notice: `Queued ${queued} replay request${queued === 1 ? "" : "s"}.${skipNote}${mutedNote} Router will process within a minute.`,
    };
  });
}

/**
 * Queue replays for every unresolved dead-letter in the workspace, regardless
 * of how many are rendered on /deliveries (which paginates at 50). Used to
 * recover from incident-scale backlogs — operator clicks "Replay all
 * unresolved (N)" once the underlying issue is fixed.
 *
 * "Unresolved" matches the dashboard's `dead_letters.resolved_at IS NULL`
 * reads, so we don't re-queue events that already had a successful replay
 * land after the failure.
 *
 */
export async function requestReplayAllUnresolved(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({ billing: "replay" }, async ({ workspaceId, actorUserId }) => {
    const reason = formValue(formData, "reason") || "replay_all_unresolved";
    // Optional narrow filter: when present, only replay unresolved
    // failures whose dead_letters.reason matches. Used by per-cause
    // "Replay all N" buttons on the dashboard Activity card so an
    // operator can target one failure mode without dragging in
    // unrelated reasons.
    const reasonFilter = formValue(formData, "reason_filter") || null;
    let queued = 0;
    // Unresolved candidates withheld because their fingerprint is actively muted —
    // surfaced distinctly in the notice so "replay all" never silently drops them.
    let mutedSkipped = 0;
    // Set inside the transaction once we know there is work to track, so the
    // success notice + cache busting can reference the durable job.
    let jobId: string | null = null;

    try {
      await withTransaction(async (client) => {
        // Keep the incident-scale path inside Postgres. Pulling every
        // dead-letter id through the Vercel action can exceed the 120s runtime
        // limit before the worker ever sees the replay requests.
        //
        // Candidates: one row per distinct unresolved (event_id, route_id) —
        // taking the OLDEST dead letter of each pair. The in-flight dedupe,
        // mute anti-join (NULL fingerprints from pre-backfill rows never match
        // a mute, so they still replay), tracking-job creation, and audit all
        // live in enqueueReplays.
        const result = await enqueueReplays(client, {
          workspaceId,
          actorUserId,
          reason,
          candidates: {
            sql: `SELECT DISTINCT ON (dl.event_id, dl.route_id)
                         dl.event_id, dl.source_id, dl.r2_key, 'route' AS scope,
                         dl.route_id, NULL::text AS destination_id,
                         dl.reason AS failure_reason, dl.fingerprint
                    FROM dead_letters dl
                   WHERE dl.workspace_id = $1
                     AND ($2::text IS NULL OR dl.reason = $2)
                     AND dl.resolved_at IS NULL
                   ORDER BY dl.event_id, dl.route_id, dl.errored_at ASC`,
            params: [workspaceId, reasonFilter],
          },
          audit: {
            action: "replay.requested_all_unresolved",
            metadata: { reason, reason_filter: reasonFilter },
          },
          job: { reasonFilter },
        });
        queued = result.queued;
        mutedSkipped = result.mutedSkipped;
        jobId = result.jobId;
      });
    } catch {
      return { error: "Could not queue the replay requests. Try again." };
    }

    if (queued === 0) {
      const activeResult = await db().query<{ count: string }>(
        `SELECT COUNT(DISTINCT (dl.event_id, dl.route_id))::text AS count
           FROM dead_letters dl
          WHERE dl.workspace_id = $1
            AND ($2::text IS NULL OR dl.reason = $2)
            AND dl.resolved_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM replay_requests rr
               WHERE rr.workspace_id = dl.workspace_id
                 AND rr.event_id = dl.event_id
                 AND rr.scope = 'route'
                 AND rr.route_id IS NOT DISTINCT FROM dl.route_id
                 AND rr.state IN ('pending', 'in_progress')
            )`,
        [workspaceId, reasonFilter],
      );
      const active = Number(activeResult.rows[0]?.count ?? "0");
      if (active > 0) {
        return {
          notice: `${active.toLocaleString("en-US")} replay request${active === 1 ? "" : "s"} already queued or running.`,
        };
      }
      if (mutedSkipped > 0) {
        return {
          notice: `${mutedSkipped.toLocaleString("en-US")} matching unresolved failure${mutedSkipped === 1 ? " is" : "s are"} muted — unmute to replay.`,
        };
      }
      return {
        notice: reasonFilter
          ? `No unresolved failures with reason "${reasonFilter}" to replay.`
          : "No unresolved failures to replay.",
      };
    }

    bustReplayTags(workspaceId, { jobs: jobId !== null });

    const scopeNote = reasonFilter ? ` matching "${reasonFilter}"` : "";
    const mutedNote =
      mutedSkipped > 0
        ? ` ${mutedSkipped.toLocaleString("en-US")} muted fingerprint${mutedSkipped === 1 ? " was" : "s were"} skipped — unmute to include them.`
        : "";
    return {
      notice: `Queued ${queued} replay request${queued === 1 ? "" : "s"}${scopeNote}.${mutedNote} Track progress on Deliveries.`,
    };
  });
}

/**
 * Queue replays for every unresolved dead-letter that shares the same
 * (source_id, reason) as the dead-letter the operator opened in /investigate.
 * One transaction, one audit row. Used by the "Replay all unresolved (N)"
 * button on the investigate page so the operator can drain a recurring
 * failure mode without leaving the page.
 *
 * Reuses the same NOT EXISTS predicate as requestReplayAllUnresolved so a
 * DL that already has a successful replay landed after the failure is not
 * re-queued. Also skips rows already pending/in-progress so repeat clicks
 * do not duplicate a large incident replay.
 */
export async function requestInvestigationReplayAll(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({ billing: "replay" }, async ({ workspaceId, actorUserId }) => {
    const deadLetterId = formValue(formData, "dead_letter_id");
    if (!deadLetterId || !/^[0-9]+$/.test(deadLetterId)) {
      return { error: "Investigation reference is missing or invalid." };
    }

    const reason = formValue(formData, "reason") || "investigation_replay_all";
    let queued = 0;
    let mutedSkipped = 0;
    let groupSourceId: string | null = null;
    let groupReason: string | null = null;
    let jobId: string | null = null;

    try {
      await withTransaction(async (client) => {
        const anchorRes = await client.query<{
          source_id: string;
          reason: string;
        }>(
          `SELECT source_id, reason
             FROM dead_letters
            WHERE id = $1::bigint AND workspace_id = $2
            LIMIT 1`,
          [deadLetterId, workspaceId],
        );
        const anchor = anchorRes.rows[0];
        if (!anchor) return;
        groupSourceId = anchor.source_id;
        groupReason = anchor.reason;

        // Candidates: every unresolved dead letter sharing the anchor's
        // (source_id, reason), one per distinct (event_id, route_id). The
        // in-flight dedupe, mute anti-join, tracking-job creation, and audit
        // all live in enqueueReplays — identical to requestReplayAllUnresolved.
        const result = await enqueueReplays(client, {
          workspaceId,
          actorUserId,
          reason,
          candidates: {
            sql: `SELECT DISTINCT ON (dl.event_id, dl.route_id)
                         dl.event_id, dl.source_id, dl.r2_key, 'route' AS scope,
                         dl.route_id, NULL::text AS destination_id,
                         dl.reason AS failure_reason, dl.fingerprint
                    FROM dead_letters dl
                   WHERE dl.workspace_id = $1
                     AND dl.source_id = $2
                     AND dl.reason = $3
                     AND dl.resolved_at IS NULL
                   ORDER BY dl.event_id, dl.route_id, dl.errored_at ASC`,
            params: [workspaceId, anchor.source_id, anchor.reason],
          },
          audit: {
            action: "replay.requested_investigation",
            metadata: {
              dead_letter_id: deadLetterId,
              source_id: anchor.source_id,
              reason: anchor.reason,
            },
          },
          job: { reasonFilter: anchor.reason },
        });
        queued = result.queued;
        mutedSkipped = result.mutedSkipped;
        jobId = result.jobId;
      });
    } catch {
      return { error: "Could not queue the replay requests. Try again." };
    }

    if (groupSourceId === null || groupReason === null) {
      return { error: "Investigation reference not found in this workspace." };
    }

    if (queued === 0) {
      return {
        notice:
          mutedSkipped > 0
            ? `This group is muted (${mutedSkipped.toLocaleString("en-US")} unresolved) — unmute to replay.`
            : "No unresolved failures left in this group.",
      };
    }

    bustReplayTags(workspaceId, { jobs: jobId !== null });

    const mutedNote =
      mutedSkipped > 0
        ? ` ${mutedSkipped.toLocaleString("en-US")} muted fingerprint${mutedSkipped === 1 ? " was" : "s were"} skipped.`
        : "";
    return {
      notice: `Queued ${queued} replay request${queued === 1 ? "" : "s"}.${mutedNote} Progress will update below.`,
    };
  });
}

/**
 * Archive (resolve without replaying) every unresolved dead-letter in the
 * (source, reason) group the operator is investigating. Use for benign /
 * accepted failures the operator just wants out of the inbox — e.g. the
 * `duplicate_in_flight` dedup events, or a one-off `max_retries_exceeded`.
 *
 * Sets `resolved_at` (leaving `resolved_by_replay_id` NULL to distinguish a
 * manual archive from a replay-driven resolution). Rows stay for audit. Not
 * billable, so no billing gate — but still write-role gated + audit-logged.
 */
export async function archiveInvestigationFailures(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const deadLetterId = formValue(formData, "dead_letter_id");
    if (!deadLetterId || !/^[0-9]+$/.test(deadLetterId)) {
      return { error: "Investigation reference is missing or invalid." };
    }

    let archived = 0;
    let found = false;

    try {
      await withTransaction(async (client) => {
        const anchorRes = await client.query<{ source_id: string; reason: string }>(
          `SELECT source_id, reason
             FROM dead_letters
            WHERE id = $1::bigint AND workspace_id = $2
            LIMIT 1`,
          [deadLetterId, workspaceId],
        );
        const anchor = anchorRes.rows[0];
        if (!anchor) return;
        found = true;

        const result = await client.query<{ archived: string }>(
          `WITH updated AS (
             UPDATE dead_letters
                SET resolved_at = now()
              WHERE workspace_id = $1
                AND source_id = $2
                AND reason = $3
                AND resolved_at IS NULL
              RETURNING 1
           )
           SELECT COUNT(*)::text AS archived FROM updated`,
          [workspaceId, anchor.source_id, anchor.reason],
        );
        archived = Number(result.rows[0]?.archived ?? "0");

        if (archived > 0) {
          await audit({
            action: "dead_letter.archived",
            targetType: "dead_letter",
            targetId: deadLetterId,
            metadata: { source_id: anchor.source_id, reason: anchor.reason, archived },
          }, client);
        }
      });
    } catch {
      return { error: "Could not archive these failures. Try again." };
    }

    if (!found) {
      return { error: "Investigation reference not found in this workspace." };
    }
    if (archived === 0) {
      return { notice: "No unresolved failures left in this group." };
    }

    tags("deadLetters");
    return {
      notice: `Archived ${archived} failure${archived === 1 ? "" : "s"}.`,
    };
  });
}

export async function fetchDeadLetterPayload(
  deadLetterId: string,
): Promise<{ payload?: unknown; error?: string }> {
  const session = await requireSession();
  const result = await db().query<{
    r2_key: string;
    event_id: string;
    source_id: string;
  }>(
    `SELECT r2_key, event_id, source_id
       FROM dead_letters
      WHERE id = $1::bigint AND workspace_id = $2
      LIMIT 1`,
    [deadLetterId, session.activeWorkspace.workspace_id],
  );
  const row = result.rows[0];
  if (!row) return { error: "Failed-delivery row not found in this workspace." };
  try {
    const payload = await fetchPayloadForR2Key(row.r2_key, {
      workspaceId: session.activeWorkspace.workspace_id,
      eventId: row.event_id,
      sourceId: row.source_id,
    });
    if (payload === null) {
      return { error: "Could not load the saved payload from storage." };
    }
    return { payload };
  } catch {
    return { error: "Could not load the saved payload from storage." };
  }
}
