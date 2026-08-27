"use client";

import { useActionState, useState } from "react";
import { updateSourceTransientModeAction } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { RETENTION_BOUNDS } from "../../../../lib/retention-bounds";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * AXE-35 — per-source transient mode + raw-payload retention
 * override. Transient mode sets raw retention to 0 and disables replay
 * for the source. The delivery-service R2 sweep (r2-retention.ts) then
 * purges this source's raw payloads early — within a few days of
 * delivery (a safety floor keeps them around for in-flight retries),
 * rather than the 30-day default.
 */
export function TransientModeEditor({
  sourceId,
  initialTransientMode,
  initialRetentionOverride,
  workspaceDefaultDays,
  canMutate,
  capabilityAvailable,
}: {
  sourceId: string;
  initialTransientMode: boolean;
  initialRetentionOverride: number | null;
  workspaceDefaultDays: number;
  canMutate: boolean;
  capabilityAvailable: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateSourceTransientModeAction,
    {},
  );
  const [transient, setTransient] = useState(initialTransientMode);

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="source_id" value={sourceId} />
      <label className="flex items-start gap-3 rounded-md border border-input bg-card p-3">
        <input
          type="checkbox"
          name="transient_mode"
          className="mt-0.5 size-4"
          checked={transient}
          onChange={(e) => setTransient(e.target.checked)}
          disabled={!canMutate || !capabilityAvailable}
        />
        <div className="space-y-1">
          <span className="text-sm font-medium text-foreground">Transient mode</span>
          <p className="text-xs text-muted-foreground">
            Route events and <strong>disable replay</strong> for this source. Raw payloads
            are purged early — within a few days of delivery, rather than the 30-day
            default.
          </p>
        </div>
      </label>
      <div className="space-y-1.5">
        <Label htmlFor={`retention-${sourceId}`}>Raw payload retention override (days)</Label>
        <Input
          id={`retention-${sourceId}`}
          name="raw_payload_retention_days"
          type="number"
          min={RETENTION_BOUNDS.raw_payload_retention_days.min}
          max={RETENTION_BOUNDS.raw_payload_retention_days.max}
          defaultValue={initialRetentionOverride ?? ""}
          placeholder={`inherit workspace default (${workspaceDefaultDays}d)`}
          disabled={!canMutate || !capabilityAvailable || transient}
        />
        <p className="text-[11px] text-muted-foreground">
          Override the workspace default for this source only. Ignored when transient mode
          is on (transient = 0d).
        </p>
      </div>
      {!capabilityAvailable ? (
        <Alert>
          <AlertDescription>
            The small self-host profile uses a fixed 30-day R2 lifecycle.
            Transient mode and shorter per-source raw retention require the
            full retention indexing path.
          </AlertDescription>
        </Alert>
      ) : null}
      {state.error ? (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      {state.notice ? (
        <Alert><AlertDescription>{state.notice}</AlertDescription></Alert>
      ) : null}
      {canMutate && capabilityAvailable ? (
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Save retention"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
