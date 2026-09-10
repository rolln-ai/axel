"use client";
import { useActionState } from "react";
import { acknowledgeIncidentAction } from "../../../lib/impact-alert-actions";
import { Button } from "@/components/ui/button";
export function AcknowledgeIncident({ id }: { id: string }) {
  const [state, action, pending] = useActionState(acknowledgeIncidentAction, {});
  return <form action={action} className="space-y-2">
    <input type="hidden" name="incident_id" value={id} />
    <Button variant="outline" size="sm" disabled={pending}>Acknowledge for 24 hours</Button>
    {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    {state.notice ? <p role="status" className="text-sm">{state.notice}</p> : null}
  </form>;
}
