"use client";
import { useActionState } from "react";
import { updateFlowMonitoringAction } from "../../../../lib/impact-alert-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function FlowMonitoringEditor({ sourceId, enabled, minutes, canMutate }: {
  sourceId: string; enabled: boolean; minutes: number | null; canMutate: boolean;
}) {
  const [state, action, pending] = useActionState(updateFlowMonitoringAction, {});
  return <form action={action} className="space-y-3 border-t border-border pt-5">
    <input type="hidden" name="source_id" value={sourceId} />
    <h3 className="text-sm font-medium">Traffic monitoring</h3>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name="flow_monitoring_enabled" defaultChecked={enabled} disabled={!canMutate} />
      Alert when this source stops receiving data
    </label>
    <label className="block space-y-2 text-sm">
      <span>Maximum expected gap in minutes</span>
      <Input name="alert_after_minutes" type="number" min={15} max={10080} step={1} defaultValue={minutes ?? ""} placeholder="Automatic" disabled={!canMutate} className="max-w-xs" />
    </label>
    <p className="max-w-2xl text-xs text-muted-foreground">Automatic monitoring starts after 20 events and allows three times the usual gap, with a minimum of 30 minutes. Set an explicit gap for scheduled, new, or infrequent feeds. Checks run every 15 minutes. Test events do not count.</p>
    {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    {state.notice ? <p role="status" className="text-sm">{state.notice}</p> : null}
    {canMutate ? <Button type="submit" size="sm" disabled={pending}>{pending ? "Saving…" : "Save monitoring"}</Button> : null}
  </form>;
}
