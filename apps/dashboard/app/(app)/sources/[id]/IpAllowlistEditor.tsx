"use client";

import { useActionState } from "react";
import { updateSourceIpAllowlistAction } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * AXE-34 — operator pastes a list of CIDRs (one per line). Empty
 * list means "no allowlist" (legacy behaviour, accept any IP).
 * The textarea accepts `#` comments so operators can label which
 * provider each range belongs to.
 */
export function IpAllowlistEditor({
  sourceId,
  initialAllowlist,
  canMutate,
}: {
  sourceId: string;
  initialAllowlist: string[];
  canMutate: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateSourceIpAllowlistAction,
    {},
  );
  const initialText = initialAllowlist.join("\n");

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="source_id" value={sourceId} />
      <div className="space-y-1.5">
        <Label htmlFor={`ip-allowlist-${sourceId}`}>Inbound IP allowlist (CIDRs)</Label>
        <Textarea
          id={`ip-allowlist-${sourceId}`}
          name="allowlist"
          rows={5}
          defaultValue={initialText}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder={`# one CIDR per line; '#' comments allowed\n3.18.12.63/32\n13.107.6.152/31\n# Stripe webhook IPs`}
          disabled={!canMutate}
        />
        <p className="text-[11px] text-muted-foreground">
          {initialAllowlist.length === 0
            ? "No allowlist configured — any source IP can post to this endpoint. Add CIDRs to lock it down."
            : `Currently ${initialAllowlist.length} entr${initialAllowlist.length === 1 ? "y" : "ies"} — requests from other IPs are rejected with HTTP 403 (non-billable).`}
        </p>
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}
      {canMutate ? (
        <div className="flex justify-end">
          <Button type="submit" size="sm" variant="outline" disabled={pending}>
            {pending ? "Saving…" : "Save allowlist"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}
