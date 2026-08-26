"use client";

import { useActionState } from "react";
import {
  deleteWorkspaceAction,
  suspendWorkspaceAction,
  unsuspendWorkspaceAction,
  retryWorkspaceTeardownAction,
} from "../../../../../lib/admin-actions";
import type { ActionState } from "../../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmAction } from "../../../../_components/ConfirmAction";

export function WorkspaceAdminActions({
  workspaceId,
  workspaceName,
  status,
  adminBelongsToWorkspace,
}: {
  workspaceId: string;
  workspaceName: string;
  status: "active" | "suspended" | "deleted" | "deleting";
  adminBelongsToWorkspace: boolean;
}) {
  const [suspendState, suspendAction, suspendPending] = useActionState<ActionState, FormData>(
    suspendWorkspaceAction,
    {},
  );
  const [unsuspendState, unsuspendAction, unsuspendPending] = useActionState<ActionState, FormData>(
    unsuspendWorkspaceAction,
    {},
  );
  const [deleteState, deleteAction, deletePending] = useActionState<ActionState, FormData>(
    deleteWorkspaceAction,
    {},
  );
  const [retryState, retryAction, retryPending] = useActionState<ActionState, FormData>(
    retryWorkspaceTeardownAction,
    {},
  );

  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {/* Suspend / unsuspend */}
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">
          {status === "suspended" ? "Re-activate workspace" : "Suspend workspace"}
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {status === "suspended"
            ? "Restores active status and re-enables sources to their prior state."
            : "Blocks write actions and pauses ingestion. Read access is preserved."}
        </p>

        {status === "suspended" ? (
          <form action={unsuspendAction} className="mt-4">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            {unsuspendState.error ? (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{unsuspendState.error}</AlertDescription>
              </Alert>
            ) : null}
            {unsuspendState.notice ? (
              <Alert className="mb-3">
                <AlertDescription>{unsuspendState.notice}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" disabled={unsuspendPending}>
              {unsuspendPending ? "Re-activating…" : "Re-activate workspace"}
            </Button>
          </form>
        ) : (
          <form action={suspendAction} className="mt-4 space-y-3">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <div className="space-y-1.5">
              <Label htmlFor="suspend-reason">Reason (optional)</Label>
              <Textarea
                id="suspend-reason"
                name="reason"
                rows={2}
                placeholder="Visible in audit log only"
                disabled={suspendPending}
              />
            </div>
            {adminBelongsToWorkspace ? (
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" name="confirm_self" value="yes" />
                <span>
                  I understand I belong to this workspace and want to suspend it anyway.
                </span>
              </label>
            ) : null}
            {suspendState.error ? (
              <Alert variant="destructive">
                <AlertDescription>{suspendState.error}</AlertDescription>
              </Alert>
            ) : null}
            {suspendState.notice ? (
              <Alert>
                <AlertDescription>{suspendState.notice}</AlertDescription>
              </Alert>
            ) : null}
            <ConfirmAction
              title="Suspend workspace"
              body="Suspend this workspace? Edge cache deletion is confirmed, but cache propagation or a lookup already in flight can persist for up to five minutes."
              confirmLabel="Suspend"
              destructive
            >
              <Button type="button" variant="destructive" disabled={suspendPending}>
                {suspendPending ? "Suspending…" : "Suspend workspace"}
              </Button>
            </ConfirmAction>
          </form>
        )}
      </div>

      {/* Delete / teardown */}
      {status === "deleting" ? (
        <div className="rounded-lg border border-amber-500/40 bg-card p-5">
          <h2 className="text-sm font-semibold text-amber-600">Teardown in progress</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            This workspace is scheduled for deletion. The teardown cron cancels billing, wipes
            ClickHouse + R2, then hard-deletes the row. If it&apos;s stuck, run one step now — the
            actual error (which the cron swallows) is surfaced below.
          </p>
          <form action={retryAction} className="mt-4">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            {retryState.error ? (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription className="break-all font-mono text-[11px]">
                  {retryState.error}
                </AlertDescription>
              </Alert>
            ) : null}
            {retryState.notice ? (
              <Alert className="mb-3">
                <AlertDescription>{retryState.notice}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" variant="outline" disabled={retryPending}>
              {retryPending ? "Running teardown…" : "Retry teardown now"}
            </Button>
          </form>
        </div>
      ) : (
        <div className="rounded-lg border border-red-500/30 bg-card p-5">
          <h2 className="text-sm font-semibold text-red-600">Delete workspace</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Schedules deletion: the workspace flips to <code className="font-mono text-xs">deleting</code>,
            source edge-cache deletion is confirmed, and cache propagation or a lookup already in
            flight can persist for up to five minutes. The teardown cron then cancels billing, wipes ClickHouse
            + R2, and hard-deletes everything. Cannot be undone.
          </p>
          <form action={deleteAction} className="mt-4 space-y-3">
            <input type="hidden" name="workspace_id" value={workspaceId} />
            <div className="space-y-1.5">
              <Label htmlFor="confirm-name">
                Type <code className="font-mono text-xs">{workspaceName}</code> to confirm
              </Label>
              <Input
                id="confirm-name"
                name="confirm_name"
                autoComplete="off"
                disabled={deletePending}
              />
            </div>
            {deleteState.error ? (
              <Alert variant="destructive">
                <AlertDescription>{deleteState.error}</AlertDescription>
              </Alert>
            ) : null}
            <Button type="submit" variant="destructive" disabled={deletePending}>
              {deletePending ? "Scheduling…" : "Delete workspace"}
            </Button>
          </form>
        </div>
      )}
    </section>
  );
}
