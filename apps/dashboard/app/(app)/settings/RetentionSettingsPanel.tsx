"use client";

import { useActionState } from "react";
import { updateWorkspaceRetentionAction } from "../../../lib/workspace-settings-actions";
import type { ActionState } from "../../../lib/action-data";
import { RETENTION_BOUNDS } from "../../../lib/retention-bounds";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * AXE-35 — workspace-level retention configuration. Each field is
 * optional; only changed values get sent to the action.
 */
export function RetentionSettingsPanel({
  current,
  canEdit,
  rawPayloadControlAvailable,
}: {
  current: {
    raw_payload_retention_days: number;
    dead_letter_retention_days: number;
    replay_request_retention_days: number;
    audit_log_retention_days: number;
  };
  canEdit: boolean;
  rawPayloadControlAvailable: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateWorkspaceRetentionAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RetentionField
          name="raw_payload_retention_days"
          label="Raw payload (days)"
          hint="Raw event bodies in object storage. Deleted at this age, capped at 30 days. A short safety floor (a few days) keeps payloads available for in-flight delivery retries, so very low values — including 0 (transient) — still take a few days to fully clear."
          min={RETENTION_BOUNDS.raw_payload_retention_days.min}
          max={RETENTION_BOUNDS.raw_payload_retention_days.max}
          defaultValue={current.raw_payload_retention_days}
          disabled={!canEdit || !rawPayloadControlAvailable}
        />
        <RetentionField
          name="dead_letter_retention_days"
          label="Dead letters (days)"
          hint="Failed delivery rows shown in the inbox. Stored in Postgres, so capped at 365d. Lower if compliance prohibits keeping payload context."
          min={RETENTION_BOUNDS.dead_letter_retention_days.min}
          max={RETENTION_BOUNDS.dead_letter_retention_days.max}
          defaultValue={current.dead_letter_retention_days}
          disabled={!canEdit}
        />
        <RetentionField
          name="replay_request_retention_days"
          label="Replay requests (days)"
          hint="Replay history. Capped at 90d (raw payloads needed to replay clear at 30d anyway)."
          min={RETENTION_BOUNDS.replay_request_retention_days.min}
          max={RETENTION_BOUNDS.replay_request_retention_days.max}
          defaultValue={current.replay_request_retention_days}
          disabled={!canEdit}
        />
        <RetentionField
          name="audit_log_retention_days"
          label="Audit log (days)"
          hint="Who-did-what. Compliance frameworks (SOC2, ISO27001) usually want 365+; keep it long."
          min={RETENTION_BOUNDS.audit_log_retention_days.min}
          max={RETENTION_BOUNDS.audit_log_retention_days.max}
          defaultValue={current.audit_log_retention_days}
          disabled={!canEdit}
        />
      </div>
      {!rawPayloadControlAvailable ? (
        <Alert>
          <AlertDescription>
            The small self-host profile fixes raw payload expiry at 30 days. Add
            ClickHouse and the retention indexing path before offering shorter
            raw retention or transient mode. Postgres retention settings below
            remain enforceable.
          </AlertDescription>
        </Alert>
      ) : null}
      {state.error ? (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      {state.notice ? (
        <Alert><AlertDescription>{state.notice}</AlertDescription></Alert>
      ) : null}
      {canEdit ? (
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Saving…" : "Save retention"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

function RetentionField({
  name,
  label,
  hint,
  min,
  max,
  defaultValue,
  disabled,
}: {
  name: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  defaultValue: number;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input
        id={name}
        name={name}
        type="number"
        min={min}
        max={max}
        defaultValue={defaultValue}
        disabled={disabled}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  );
}
