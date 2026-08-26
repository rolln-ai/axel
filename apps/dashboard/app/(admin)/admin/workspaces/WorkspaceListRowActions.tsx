"use client";

import { useActionState } from "react";
import { deleteWorkspaceAction } from "../../../../lib/admin-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Per-row delete for the admin workspaces list. Same confirm-by-name guard +
 * two-phase teardown as the detail page — just reachable without clicking in.
 * Hidden once a workspace is already tearing down or gone.
 */
export function WorkspaceListRowActions({
  workspaceId,
  workspaceName,
  status,
}: {
  workspaceId: string;
  workspaceName: string;
  status: "active" | "suspended" | "deleted" | "deleting";
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(deleteWorkspaceAction, {});

  if (status === "deleting" || status === "deleted") {
    return <span className="text-[11px] text-muted-foreground">—</span>;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-red-600 hover:text-red-600">
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {workspaceName}</DialogTitle>
          <DialogDescription>
            Schedules deletion: source edge-cache deletion is confirmed before the change; cache
            propagation or a lookup already in flight can persist for up to five minutes. The teardown cron cancels
            billing, wipes ClickHouse + R2, and hard-deletes everything. Cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <form action={action} className="space-y-3">
          <input type="hidden" name="workspace_id" value={workspaceId} />
          <div className="space-y-1.5">
            <Label htmlFor={`confirm-${workspaceId}`}>
              Type <code className="font-mono text-xs">{workspaceName}</code> to confirm
            </Label>
            <Input id={`confirm-${workspaceId}`} name="confirm_name" autoComplete="off" disabled={pending} />
          </div>
          {state.error ? (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Scheduling…" : "Delete workspace"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
