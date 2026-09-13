import Link from "next/link";
import { db } from "../../../lib/db";
import type { PipelineIncident } from "../../../lib/impact-alerts";
import { impactMessage } from "../../../lib/impact-alert-policy";
import { LocalTime } from "../../_components/LocalTime";
import { AcknowledgeIncident } from "./AcknowledgeIncident";

export async function PipelineIncidents({ workspaceId, canMutate }: { workspaceId: string; canMutate: boolean }) {
  try {
    const incidents = (await db().query<PipelineIncident>(`SELECT id, kind, snapshot, opened_at::text,
      observed_at::text, acknowledged_until::text FROM pipeline_incidents
      WHERE workspace_id = $1 AND resolved_at IS NULL ORDER BY opened_at DESC`, [workspaceId])).rows;
    const monitor = (await db().query<{ checked_at: string | null; unsent: string }>(`SELECT impact_monitor_checked_at::text AS checked_at,
      (SELECT count(*) FROM alert_email_outbox WHERE workspace_id = $1 AND state = 'needs_review')::text AS unsent
      FROM workspaces WHERE id = $1`, [workspaceId])).rows[0];
    const stale = !monitor?.checked_at || Date.now() - Date.parse(monitor.checked_at) > 45 * 60_000;
    return <section className="mb-6 space-y-3" aria-label="Data flow incidents">
      <h2 className="text-base font-semibold">Data flow incidents</h2>
      {stale ? <p role="alert" className="rounded-md border border-destructive p-3 text-sm">Monitoring has not completed a recent check. Current data flow is unverified.</p> : <p className="text-xs text-muted-foreground">Last checked <LocalTime value={monitor.checked_at!} />. Source Settings can override the learned traffic window.</p>}
      {Number(monitor?.unsent ?? 0) > 0 ? <p role="alert" className="text-sm text-destructive">Some incident emails could not be confirmed and need administrator review. The incidents remain visible here.</p> : null}
      {incidents.length === 0 ? <p className="text-sm text-muted-foreground">No active incidents detected. This does not confirm that historical gaps have been backfilled.</p> : null}
      {incidents.map(incident => {
        const message = impactMessage(incident.kind, incident.snapshot, "opened");
        const acknowledged = incident.acknowledged_until && Date.parse(incident.acknowledged_until) > Date.now();
        return <article key={incident.id} className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold">{message.title}</h3>
          <p className="whitespace-pre-line text-sm text-muted-foreground">{message.body}</p>
          <p className="text-xs text-muted-foreground">Detected <LocalTime value={incident.opened_at} />. {acknowledged ? <>Reminders paused until <LocalTime value={incident.acknowledged_until!} />.</> : null}</p>
          <div className="flex flex-wrap gap-4 text-sm"><Link className="underline" href={`/sources/${encodeURIComponent(incident.snapshot.sourceId)}?tab=settings`}>Source settings</Link>{incident.snapshot.destinationId ? <Link className="underline" href={`/destinations/${encodeURIComponent(incident.snapshot.destinationId)}`}>Destination</Link> : null}</div>
          {canMutate && !acknowledged ? <AcknowledgeIncident id={incident.id} /> : null}
        </article>;
      })}
    </section>;
  } catch {
    return <p role="alert" className="mb-6 text-sm text-destructive">Incident monitoring is unavailable. Current data flow is unverified.</p>;
  }
}
