import Link from "next/link";
import { AlertTriangle, CheckCircle2, Sparkles } from "lucide-react";
import { db } from "../../../lib/db";
import type { PipelineIncident } from "../../../lib/impact-alerts";
import { impactMessage, type ImpactSnapshot } from "../../../lib/impact-alert-policy";
import { assignGroupsToIncidents, incidentIsFixable } from "../../../lib/incident-fix-match";
import type { InboxGroup } from "../../../lib/inbox";
import { LocalTime } from "../../_components/LocalTime";
import { AcknowledgeIncident } from "./AcknowledgeIncident";
import { FixIncident } from "./FixIncident";

type IncidentRow = Pick<PipelineIncident, "id" | "kind" | "snapshot" | "opened_at" | "acknowledged_until" | "fix_requested_at">;

/**
 * One card per open incident, one button per card. Everything the old page
 * spread across three sections (incident, dead-letter fingerprints, links)
 * now lives on the card, with the noisy parts behind "Details".
 */
export async function Incidents({
  workspaceId,
  canMutate,
  groups,
}: {
  workspaceId: string;
  canMutate: boolean;
  /** Active dead-letter groups; each is shown under the incident that owns it. */
  groups: InboxGroup[];
}) {
  let incidents: IncidentRow[];
  let monitor: { checked_at: string | null; unsent: string } | undefined;
  try {
    incidents = (await db().query<IncidentRow>(
      `SELECT id, kind, snapshot, opened_at::text, acknowledged_until::text, fix_requested_at::text
         FROM pipeline_incidents WHERE workspace_id = $1 AND resolved_at IS NULL ORDER BY opened_at DESC`,
      [workspaceId],
    )).rows;
    monitor = (await db().query<{ checked_at: string | null; unsent: string }>(
      `SELECT impact_monitor_checked_at::text AS checked_at,
              (SELECT count(*) FROM alert_email_outbox WHERE workspace_id = $1 AND state = 'needs_review')::text AS unsent
         FROM workspaces WHERE id = $1`,
      [workspaceId],
    )).rows[0];
  } catch {
    return { node: <p role="alert" className="mb-6 text-sm text-destructive">Incident monitoring is unavailable. Current data flow is unverified.</p>, unassigned: groups };
  }
  const stale = !monitor?.checked_at || Date.now() - Date.parse(monitor.checked_at) > 45 * 60_000;
  const { byIncident, unassigned } = assignGroupsToIncidents(incidents, groups);

  const node = (
    <section className="mb-6 space-y-3" aria-label="Needs attention">
      {stale ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm">Monitoring has not completed a recent check. Current data flow is unverified.</p>
      ) : null}
      {Number(monitor?.unsent ?? 0) > 0 ? (
        <p role="alert" className="text-sm text-destructive">Some incident emails could not be confirmed and need administrator review. The incidents remain visible here.</p>
      ) : null}
      {incidents.length === 0 && unassigned.length === 0 ? (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-6">
          <CheckCircle2 className="size-5 text-emerald-600 dark:text-emerald-400" />
          <div>
            <p className="text-sm font-medium">All clear.</p>
            <p className="text-xs text-muted-foreground">
              No open incidents and no failed deliveries.
              {monitor?.checked_at ? <> Last checked <LocalTime value={monitor.checked_at} />.</> : null}
            </p>
          </div>
        </div>
      ) : null}
      {incidents.map((incident) => (
        <IncidentCard
          key={incident.id}
          incident={incident}
          groups={byIncident.get(incident) ?? []}
          canMutate={canMutate}
        />
      ))}
    </section>
  );
  return { node, unassigned };
}

function IncidentCard({ incident, groups, canMutate }: { incident: IncidentRow; groups: InboxGroup[]; canMutate: boolean }) {
  const message = impactMessage(incident.kind, incident.snapshot, "opened");
  const acknowledged = incident.acknowledged_until !== null && Date.parse(incident.acknowledged_until) > Date.now();
  const fixable = incidentIsFixable(incident);
  const failed = incident.snapshot.failedCount;
  const waiting = incident.snapshot.waitingCount;
  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="size-4 shrink-0 text-destructive" />
            {message.title}
          </h3>
          <p className="text-sm text-muted-foreground">{plainSummary(incident.snapshot)}</p>
          <p className="text-xs text-muted-foreground">
            {failed > 0 ? <>{failed.toLocaleString("en-US")} failed event{failed === 1 ? "" : "s"} kept for replay. </> : null}
            {waiting > 0 ? <>{waiting.toLocaleString("en-US")} waiting over 30 minutes. </> : null}
            Detected <LocalTime value={incident.opened_at} />.
            {acknowledged ? <> Reminder emails paused until <LocalTime value={incident.acknowledged_until!} />.</> : null}
          </p>
        </div>
        {canMutate && fixable ? (
          <FixIncident incidentId={incident.id} fixRequestedAt={incident.fix_requested_at} />
        ) : canMutate ? (
          <Link
            href={`/sources/${encodeURIComponent(incident.snapshot.sourceId)}?tab=settings`}
            className="inline-flex h-8 items-center rounded-md border border-border px-3 text-xs font-medium hover:bg-muted/40"
          >
            Check source setup
          </Link>
        ) : null}
      </div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Details</summary>
        <div className="mt-3 space-y-3 border-t border-border pt-3">
          <p className="whitespace-pre-line text-xs text-muted-foreground">{message.body}</p>
          <div className="flex flex-wrap gap-4 text-xs">
            <Link className="underline" href={`/sources/${encodeURIComponent(incident.snapshot.sourceId)}?tab=settings`}>Source settings</Link>
            {incident.snapshot.destinationId ? (
              <Link className="underline" href={`/destinations/${encodeURIComponent(incident.snapshot.destinationId)}`}>Destination</Link>
            ) : null}
          </div>
          {groups.length > 0 ? (
            <ul className="divide-y divide-border rounded-md border border-border">
              {groups.map((group) => (
                <li key={group.fingerprint} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <span className="shrink-0 font-semibold">×{group.count.toLocaleString("en-US")}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="capitalize text-muted-foreground">{group.reason.replace(/_/g, " ")}</span>
                    {group.message_excerpt ? <> · {group.message_excerpt}</> : null}
                  </span>
                  {group.muted_until ? <span className="shrink-0 italic text-muted-foreground">muted</span> : null}
                  <Link
                    href={`/deliveries/${group.exemplar_id}/investigate`}
                    prefetch={false}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-muted-foreground hover:text-foreground"
                  >
                    <Sparkles className="size-3" />
                    Investigate
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
          {canMutate && !acknowledged ? <AcknowledgeIncident id={incident.id} /> : null}
        </div>
      </details>
    </article>
  );
}

function plainSummary(snapshot: ImpactSnapshot): string {
  switch (snapshot.cause) {
    case "no_traffic":
      return "No events have arrived from the sender in the expected window. Check the webhook at the sender; Axel cannot replay what it never received.";
    case "schema_mismatch":
      return "The destination rejected some events because a field does not match its column type. Fix now applies the safe conversion and replays them.";
    case "authorization_failed":
      return "The destination rejected Axel's credentials. Update them on the destination page, then click Fix now to replay.";
    case "destination_paused":
      return "Delivery to this destination is paused. Resume it on the destination page, then click Fix now to replay.";
    case "backlog":
      return "Events have waited over 30 minutes for this destination. Fix now replays any that failed; if the queue is stuck, check the destination.";
    default:
      return "Some events could not be delivered. Axel kept them; Fix now replays them and clears this alert once they land.";
  }
}
