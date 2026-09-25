"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  dismissIncidentAction,
  restoreIncidentAction,
  type IncidentDismissResult,
} from "../../../lib/impact-alert-actions";

/**
 * "Ignore and close" on an incident card, and its undo on the Ignored list.
 * Both refresh the page on success so the card moves between the two views.
 */
export function DismissIncident({ incidentId, mode }: { incidentId: string; mode: "dismiss" | "restore" }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick() {
    setError(null);
    start(async () => {
      let result: IncidentDismissResult;
      try {
        result = mode === "dismiss"
          ? await dismissIncidentAction({ incidentId })
          : await restoreIncidentAction({ incidentId });
      } catch {
        setError("Axel did not get a reply from the server. Reload the Inbox and try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Something went wrong. Try again.");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button variant="outline" size="sm" onClick={onClick} disabled={pending} aria-live="polite">
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : mode === "dismiss" ? <X className="size-3.5" /> : <RotateCcw className="size-3.5" />}
        {mode === "dismiss" ? "Ignore and close" : "Bring back"}
      </Button>
      {error ? <p role="alert" className="max-w-xs text-right text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
