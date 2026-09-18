"use server";

import { revalidatePath } from "next/cache";
import { db, withTransaction } from "./db";
import { withWorkspaceMutation } from "./with-mutation";
import { bustReplayTags, enqueueReplays } from "./replay-enqueue";
import { loadImpactObservations } from "./impact-alert-health";
import { recordImpactObservations, type PipelineIncident } from "./impact-alerts";
import { incidentIsFixable, incidentScope, type IncidentScope } from "./incident-fix-match";
import { dataTypeRepairFor } from "./dead-letter-repair";
import { fingerprintFor } from "./inbox";
import {
  applyFingerprintRepair,
  applyFingerprintSchemaRepair,
  previewFingerprintRepair,
} from "./inbox-actions";
import type { InboxRepairSpec } from "./inbox-repair";

/**
 * One-click incident fix for the Inbox.
 *
 * The operator sees one alert and one button. Behind it Axel does what the
 * old page asked them to do by hand:
 *
 *   1. lifts any mutes on the incident's fingerprints (they asked for a fix,
 *      not silence);
 *   2. for permanent data-shape failures, applies the same safe repair the
 *      "Fix data" dialog offers (widen the BigQuery column when possible,
 *      otherwise add the conversion to the route) and queues those replays;
 *   3. queues a replay for every other unresolved failed event in the
 *      incident's (source, route, destination) scope, tracked as one job so
 *      the progress bar shows it;
 *   4. stamps the incident so the next healthy check closes it at once.
 *
 * The alert itself clears from the monitor, never from here: a fix only
 * counts once the replays land and a newer successful delivery is seen.
 */

export interface FixIncidentResult {
  ok: boolean;
  error?: string;
  notice?: string;
  queued: number;
  repaired: number;
  /** Fingerprints Axel could not repair on its own; the operator gets a hint. */
  unrepaired: string[];
}

interface IncidentRow extends Pick<PipelineIncident, "id" | "kind" | "snapshot"> {}

interface ScopedFingerprint {
  fingerprint: string;
  exemplar_id: string;
  reason: string;
  message: string;
}

export async function fixIncidentAction(input: { incidentId: string }): Promise<FixIncidentResult> {
  const fail = (error: string): FixIncidentResult => ({ ok: false, error, queued: 0, repaired: 0, unrepaired: [] });
  return withWorkspaceMutation<FixIncidentResult>(
    { billing: "replay", gateError: fail },
    async ({ workspaceId, actorUserId, audit }) => {
      const incident = (await db().query<IncidentRow>(
        `SELECT id, kind, snapshot FROM pipeline_incidents
          WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NULL`,
        [workspaceId, input.incidentId],
      )).rows[0];
      if (!incident) return fail("This alert is no longer active. Refresh the Inbox.");
      if (!incidentIsFixable(incident)) {
        return fail("Axel cannot fix this one from here. The sender stopped sending; check the webhook at the sender.");
      }
      if (incident.snapshot.cause === "destination_paused") {
        return fail("Delivery to this destination is paused or its circuit is open. Resume it on the destination page, then click Fix again.");
      }
      const scope = incidentScope(incident.snapshot);

      // 1. Lift mutes in scope. Muted fingerprints never replay, and the
      //    operator has just asked for the opposite.
      const fingerprints = await scopedFingerprints(workspaceId, scope);
      if (fingerprints.length > 0) {
        await db().query(
          `UPDATE dead_letter_mutes SET until = now()
            WHERE workspace_id = $1 AND fingerprint = ANY($2::text[]) AND (until IS NULL OR until > now())`,
          [workspaceId, fingerprints.map((f) => f.fingerprint)],
        );
      }

      // 2. Permanent data-shape failures: replaying unchanged data cannot
      //    work, so apply the safe repair first. Each helper queues its own
      //    replays for the fingerprint it repaired.
      let repaired = 0;
      let repairedQueued = 0;
      const unrepaired: string[] = [];
      for (const fp of fingerprints) {
        if (!dataTypeRepairFor({ reason: fp.reason, message: fp.message, routeId: scope.routeId, destinationId: scope.destinationId })) continue;
        const outcome = await repairFingerprint(fp);
        if (outcome.ok) {
          repaired += 1;
          repairedQueued += outcome.queued;
        } else {
          unrepaired.push(outcome.error);
        }
      }

      // 3. Replay everything else still unresolved in scope, as one tracked
      //    job. Rows already queued by step 2 are skipped by the in-flight
      //    dedupe inside enqueueReplays.
      let queued = 0;
      let jobId: string | null = null;
      try {
        await withTransaction(async (client) => {
          const result = await enqueueReplays(client, {
            workspaceId,
            actorUserId,
            reason: "incident_fix",
            candidates: {
              sql: `SELECT DISTINCT ON (dl.event_id, dl.route_id)
                           dl.event_id, dl.source_id, dl.r2_key,
                           CASE WHEN NULLIF(dl.destination_id, '') IS NOT NULL THEN 'destination' ELSE 'route' END AS scope,
                           dl.route_id, NULLIF(dl.destination_id, '') AS destination_id,
                           dl.reason AS failure_reason, dl.fingerprint
                      FROM dead_letters dl
                     WHERE dl.workspace_id = $1
                       AND dl.source_id = $2
                       AND dl.route_id IS NOT DISTINCT FROM $3::text
                       AND NULLIF(dl.destination_id, '') IS NOT DISTINCT FROM $4::text
                       AND dl.resolved_at IS NULL
                       AND dl.is_test = false
                     ORDER BY dl.event_id, dl.route_id, dl.errored_at ASC`,
              params: [workspaceId, scope.sourceId, scope.routeId, scope.destinationId],
            },
            audit: {
              action: "incident.fix_requested",
              targetType: "pipeline_incident",
              targetId: incident.id,
              metadata: { ...scope, repaired_fingerprints: repaired, unrepaired: unrepaired.length },
            },
            job: { reasonFilter: null },
          });
          queued = result.queued;
          jobId = result.jobId;
          await client.query(
            `UPDATE pipeline_incidents SET fix_requested_at = now()
              WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NULL`,
            [workspaceId, incident.id],
          );
          // A fix is in progress; hold the next reminder email until the
          // monitor has had a chance to confirm it.
          await client.query(
            `UPDATE alert_email_outbox SET state = 'cancelled', payload = '{}'::jsonb
              WHERE workspace_id = $1 AND incident_id = $2 AND phase = 'reminder' AND state = 'pending'`,
            [workspaceId, incident.id],
          );
          if (queued === 0 && repaired === 0) {
            await audit({ action: "incident.fix_requested", targetType: "pipeline_incident", targetId: incident.id,
              metadata: { ...scope, queued: 0, repaired_fingerprints: 0, unrepaired: unrepaired.length } }, client);
          }
        });
      } catch (err) {
        console.error("[fixIncidentAction] enqueue failed", err instanceof Error ? err.message : err);
        return fail("Could not queue the replays. Try again.");
      }

      bustReplayTags(workspaceId, { jobs: jobId !== null });
      revalidatePath("/inbox");

      const total = queued + repairedQueued;
      const parts: string[] = [];
      if (repaired > 0) parts.push(`${repaired} data fix${repaired === 1 ? "" : "es"} applied`);
      if (total > 0) parts.push(`${total.toLocaleString("en-US")} replay${total === 1 ? "" : "s"} queued`);
      let notice = parts.length > 0
        ? `${parts.join(", ")}. This alert clears on its own once they land.`
        : "Nothing left to replay. Axel is re-checking this alert now.";
      if (unrepaired.length > 0) {
        notice += ` ${unrepaired.length} error${unrepaired.length === 1 ? "" : "s"} need${unrepaired.length === 1 ? "s" : ""} a manual fix: ${unrepaired[0]}`;
      }
      return { ok: true, notice, queued: total, repaired, unrepaired };
    },
  );
}

export interface RecheckIncidentResult {
  resolved: boolean;
  /** Replays for this incident still queued or running. */
  inFlight: number;
  /** Unresolved failed events still in scope. */
  remaining: number;
  error?: string;
}

/**
 * Cheap poll after a fix: while replays are in flight, only count them. Once
 * they settle, run the same health check the cron uses so the alert can
 * close without waiting up to 15 minutes for the next scan.
 */
export async function recheckIncidentAction(input: { incidentId: string }): Promise<RecheckIncidentResult> {
  return withWorkspaceMutation<RecheckIncidentResult>(
    { role: "any", gateError: (error) => ({ resolved: false, inFlight: 0, remaining: 0, error }) },
    async ({ workspaceId }) => {
      const incident = (await db().query<IncidentRow & { resolved_at: string | null }>(
        `SELECT id, kind, snapshot, resolved_at::text FROM pipeline_incidents WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, input.incidentId],
      )).rows[0];
      if (!incident) return { resolved: true, inFlight: 0, remaining: 0 };
      if (incident.resolved_at) return { resolved: true, inFlight: 0, remaining: 0 };
      const scope = incidentScope(incident.snapshot);
      const counts = (await db().query<{ in_flight: string; remaining: string }>(
        `SELECT
           (SELECT count(*) FROM replay_requests rr
             WHERE rr.workspace_id = $1 AND rr.source_id = $2
               AND rr.route_id IS NOT DISTINCT FROM $3::text
               AND rr.state IN ('pending', 'in_progress'))::text AS in_flight,
           (SELECT count(*) FROM dead_letters dl
             WHERE dl.workspace_id = $1 AND dl.source_id = $2
               AND dl.route_id IS NOT DISTINCT FROM $3::text
               AND NULLIF(dl.destination_id, '') IS NOT DISTINCT FROM $4::text
               AND dl.resolved_at IS NULL AND dl.is_test = false)::text AS remaining`,
        [workspaceId, scope.sourceId, scope.routeId, scope.destinationId],
      )).rows[0]!;
      const inFlight = Number(counts.in_flight);
      const remaining = Number(counts.remaining);
      if (inFlight > 0) return { resolved: false, inFlight, remaining };

      try {
        const observedAt = new Date();
        const observations = await loadImpactObservations(workspaceId);
        await withTransaction((client) => recordImpactObservations(client, workspaceId, observations, observedAt));
      } catch {
        // The monitor being unavailable never closes an alert; the cron retries.
        return { resolved: false, inFlight, remaining };
      }
      const after = (await db().query<{ resolved_at: string | null }>(
        `SELECT resolved_at::text FROM pipeline_incidents WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, input.incidentId],
      )).rows[0];
      const resolved = !after || after.resolved_at !== null;
      if (resolved) revalidatePath("/inbox");
      return { resolved, inFlight, remaining };
    },
  );
}

async function scopedFingerprints(workspaceId: string, scope: IncidentScope): Promise<ScopedFingerprint[]> {
  // The stored fingerprint column is stamped by the writers; recompute for
  // legacy rows that predate it so no group is missed.
  const rows = (await db().query<{ id: string; reason: string; message: string; route_id: string | null; fingerprint: string | null }>(
    `SELECT DISTINCT ON (COALESCE(dl.fingerprint, dl.reason || '|' || left(dl.message, 80)))
            dl.id::text, dl.reason, dl.message, dl.route_id, dl.fingerprint
       FROM dead_letters dl
      WHERE dl.workspace_id = $1 AND dl.source_id = $2
        AND dl.route_id IS NOT DISTINCT FROM $3::text
        AND NULLIF(dl.destination_id, '') IS NOT DISTINCT FROM $4::text
        AND dl.resolved_at IS NULL AND dl.is_test = false
      ORDER BY COALESCE(dl.fingerprint, dl.reason || '|' || left(dl.message, 80)), dl.errored_at DESC
      LIMIT 200`,
    [workspaceId, scope.sourceId, scope.routeId, scope.destinationId],
  )).rows;
  const seen = new Map<string, ScopedFingerprint>();
  for (const row of rows) {
    const fingerprint = row.fingerprint ?? await fingerprintFor({ route_id: row.route_id, reason: row.reason, message: row.message });
    if (seen.has(fingerprint)) continue;
    seen.set(fingerprint, { fingerprint, exemplar_id: row.id, reason: row.reason, message: row.message });
  }
  return Array.from(seen.values());
}

async function repairFingerprint(fp: ScopedFingerprint): Promise<{ ok: true; queued: number } | { ok: false; error: string }> {
  const preview = await previewFingerprintRepair({ fingerprint: fp.fingerprint, exemplarId: fp.exemplar_id });
  if (!preview.ok) return { ok: false, error: preview.error };
  // Prefer widening the destination column: it keeps the data intact and
  // does not touch the route. Fall back to the route-side conversion with
  // the dialog's defaults (round decimals, keep arrays as JSON).
  if (preview.schemaRepair) {
    const applied = await applyFingerprintSchemaRepair({ fingerprint: fp.fingerprint, exemplarId: fp.exemplar_id });
    if (applied.ok) return { ok: true, queued: applied.queued };
  }
  const proposed = preview.proposal.repair;
  const repair: InboxRepairSpec = proposed.kind === "coerce" && proposed.to === "integer"
    ? { ...proposed, rounding: proposed.rounding ?? "round" }
    : proposed.kind === "collapse_array"
      ? { ...proposed, format: proposed.format ?? "json" }
      : proposed;
  const applied = await applyFingerprintRepair({ fingerprint: fp.fingerprint, exemplarId: fp.exemplar_id, repair });
  return applied.ok ? { ok: true, queued: applied.queued } : { ok: false, error: applied.error };
}
