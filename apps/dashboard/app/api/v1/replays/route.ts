/**
 * AXE-29 — REST: enqueue a replay for a dead-letter event.
 *
 * POST body: { event_id: string, scope?: "all" | "route" | "destination",
 *              route_id?, destination_id? }
 *
 * The replay-request row is then picked up by the router on its
 * next poll (same path as the dashboard's "Retry" button).
 */
import { type NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { apiError, apiOk, readJsonBody, withApiAuth } from "../../../../lib/api-router";
import { replayBillingGateError } from "../../../../lib/auth-guards";
import { enqueueReplays } from "../../../../lib/replay-enqueue";

interface ReplayBody {
  event_id?: string;
  scope?: "all" | "route" | "destination";
  route_id?: string;
  destination_id?: string;
}

const VALID_SCOPES = new Set<ReplayBody["scope"]>(["all", "route", "destination"]);

export async function POST(req: NextRequest) {
  return withApiAuth(req, "replay", async (ctx) => {
    const parsed = await readJsonBody<ReplayBody>(req);
    if (!parsed.ok) return parsed.response;
    // Replays generate billable deliveries — apply the SAME billing gate the
    // server-action replay paths enforce (audit: the REST route bypassed it, so a
    // suspended/over-quota workspace could queue billable replays via API).
    const billingError = await replayBillingGateError(ctx.workspace_id);
    if (billingError) return apiError({ error: billingError, code: "billing_gate" }, 402);

    const { event_id, scope = "all", route_id, destination_id } = parsed.body;
    if (!event_id) {
      return apiError({ error: "event_id is required.", code: "invalid_body" }, 400);
    }
    // Audit-pass2 — enum-check scope before it lands in the column.
    if (!VALID_SCOPES.has(scope)) {
      return apiError(
        { error: `scope must be one of: all, route, destination.`, code: "invalid_scope" },
        400,
      );
    }
    // A scoped replay must name its target — otherwise the router gets a scope
    // with a null routeId/destinationId, which (pre-fix) fanned out to the whole
    // source. Require route_id for scope=route, route_id+destination_id for
    // scope=destination, so a partial scope can't silently re-deliver everything.
    if (scope === "route" && !route_id) {
      return apiError({ error: "route_id is required when scope is 'route'.", code: "route_id_required" }, 400);
    }
    if (scope === "destination" && (!route_id || !destination_id)) {
      return apiError(
        { error: "route_id and destination_id are required when scope is 'destination'.", code: "destination_id_required" },
        400,
      );
    }
    // Audit-pass2 — verify route_id / destination_id (if supplied)
    // belong to the same workspace. Cross-tenant defense in depth:
    // an attacker with a replay-scope key on workspace A shouldn't
    // be able to queue a replay against workspace B's resources.
    if (route_id) {
      const ok = await db().query(
        `SELECT 1 FROM routes WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
        [route_id, ctx.workspace_id],
      );
      if ((ok.rowCount ?? 0) === 0) {
        return apiError(
          { error: `route_id "${route_id}" not found in this workspace.`, code: "route_not_found" },
          404,
        );
      }
    }
    if (destination_id) {
      const ok = await db().query(
        `SELECT 1 FROM destinations WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
        [destination_id, ctx.workspace_id],
      );
      if ((ok.rowCount ?? 0) === 0) {
        return apiError(
          { error: `destination_id "${destination_id}" not found in this workspace.`, code: "destination_not_found" },
          404,
        );
      }
    }
    // Candidate: the newest matching unresolved dead-letter row (copies
    // r2_key + source_id), with the request's exact scope/route/destination
    // projected onto it. The shared tail dedups against the EXACT replay
    // being requested (scope + route + destination — not a hardcoded 'route'
    // scope, otherwise repeated scope='all'/'destination' POSTs each insert a
    // duplicate) and respects active mutes, like every server-action replay
    // path. NOTE: no cache-tag busting here — updateTag is a server-action
    // API, and the dashboard readers revalidate on their own cadence.
    const result = await enqueueReplays(db(), {
      workspaceId: ctx.workspace_id,
      actorUserId: null,
      reason: null,
      candidates: {
        sql: `SELECT dl.event_id, dl.source_id, dl.r2_key, $3::text AS scope,
                     $4::text AS route_id, $5::text AS destination_id,
                     dl.reason AS failure_reason, dl.fingerprint
                FROM dead_letters dl
               WHERE dl.workspace_id = $1
                 AND dl.event_id = $2
                 AND dl.resolved_at IS NULL
               ORDER BY dl.errored_at DESC LIMIT 1`,
        params: [ctx.workspace_id, event_id, scope, route_id ?? null, destination_id ?? null],
      },
      audit: {
        action: "api.replay.enqueued",
        targetType: "event",
        targetId: event_id,
        metadata: { api_key_id: ctx.key_id, scope },
      },
    });
    const replayId = result.replayIds[0];
    if (!result.queued || !replayId) {
      return apiError({ error: `No unresolved replayable dead-letter row for event_id "${event_id}".`, code: "not_found" }, 404);
    }
    return apiOk({ id: replayId, event_id, scope, state: "pending" }, 202);
  });
}
