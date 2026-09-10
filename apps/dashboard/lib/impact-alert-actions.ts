"use server";

import { revalidatePath } from "next/cache";
import { withTransaction } from "./db";
import { withWorkspaceMutation } from "./with-mutation";
import type { ActionState } from "./action-data";

export async function updateFlowMonitoringAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    const sourceId = String(form.get("source_id") ?? "");
    const raw = String(form.get("alert_after_minutes") ?? "").trim();
    const minutes = raw === "" ? null : Number(raw);
    if (minutes !== null && (!Number.isInteger(minutes) || minutes < 15 || minutes > 10080)) {
      return { error: "Enter a whole number from 15 to 10080 minutes, or leave blank for automatic monitoring." };
    }
    try {
      const changed = await withTransaction(async client => {
        const result = await client.query(`UPDATE sources SET alert_after_minutes = $3, flow_monitoring_enabled = $4
          WHERE workspace_id = $1 AND id = $2 RETURNING id`, [workspaceId, sourceId, minutes, form.has("flow_monitoring_enabled")]);
        if (!result.rowCount) return false;
        await audit({ action: "source.flow_monitoring_updated", targetType: "source", targetId: sourceId,
          metadata: { alert_after_minutes: minutes, enabled: form.has("flow_monitoring_enabled") } }, client);
        return true;
      });
      if (!changed) return { error: "Source not found." };
      revalidatePath(`/sources/${sourceId}`);
      return { notice: "Traffic monitoring saved." };
    } catch { return { error: "Could not save traffic monitoring. Try again." }; }
  });
}

export async function acknowledgeIncidentAction(_state: ActionState, form: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    const incidentId = String(form.get("incident_id") ?? "");
    try {
      const changed = await withTransaction(async client => {
        const result = await client.query(`UPDATE pipeline_incidents SET acknowledged_until = now() + interval '24 hours'
          WHERE workspace_id = $1 AND id = $2 AND resolved_at IS NULL RETURNING id`, [workspaceId, incidentId]);
        if (!result.rowCount) return false;
        // Cancel reminders that have not started sending. Opening and recovery
        // notices remain available; acknowledgement never resolves the incident.
        await client.query(`UPDATE alert_email_outbox SET state = 'cancelled', payload = '{}'::jsonb
          WHERE workspace_id = $1 AND incident_id = $2 AND phase = 'reminder' AND state = 'pending'`, [workspaceId, incidentId]);
        await audit({ action: "incident.acknowledged", targetType: "pipeline_incident", targetId: incidentId }, client);
        return true;
      });
      revalidatePath("/inbox");
      return changed ? { notice: "Reminder emails paused for 24 hours. Monitoring continues." } : { error: "Active incident not found." };
    } catch { return { error: "Could not acknowledge this incident. Try again." }; }
  });
}
