"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import { deleteSource, setSourceStatus } from "../../../lib/source-actions";
import type { ActionState } from "../../../lib/action-data";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { useActionStateToast } from "../../_components/Toast";

export function SourceActions({
  sourceId,
  status,
  canDelete,
}: {
  sourceId: string;
  status: string;
  canDelete: boolean;
}) {
  const router = useRouter();
  const [statusState, statusAction, statusPending] = useActionState<ActionState, FormData>(setSourceStatus, {});
  const [deleteState, deleteAction, deletePending] = useActionState<ActionState, FormData>(deleteSource, {});
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  // The delete form lives outside the dropdown (its content unmounts on
  // select), so the confirm dialog submits it by ref.
  const deleteFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (statusState.notice && !statusState.error) router.refresh();
  }, [statusState.notice, statusState.error, router]);
  useEffect(() => {
    if (deleteState.notice && !deleteState.error) router.refresh();
  }, [deleteState.notice, deleteState.error, router]);

  // Transient success outcomes surface as toasts; errors stay inline below.
  useActionStateToast({ notice: statusState.notice });
  useActionStateToast({ notice: deleteState.notice });

  const targetStatus = status === "active" ? "disabled" : "active";
  const targetLabel = status === "active" ? "Disable" : "Enable";
  const errorMsg = statusState.error ?? deleteState.error;

  return (
    <div className="flex flex-col items-end gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="Source actions">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <form action={statusAction}>
            <input type="hidden" name="source_id" value={sourceId} />
            <input type="hidden" name="status" value={targetStatus} />
            <DropdownMenuItem asChild>
              <button type="submit" disabled={statusPending} className="w-full">
                {statusPending ? "Working…" : targetLabel}
              </button>
            </DropdownMenuItem>
          </form>
          {canDelete ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={deletePending}
                onSelect={() => setConfirmDeleteOpen(true)}
              >
                {deletePending ? "Deleting…" : "Delete"}
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      {canDelete ? (
        <>
          <form action={deleteAction} ref={deleteFormRef} className="hidden">
            <input type="hidden" name="source_id" value={sourceId} />
          </form>
          <ConfirmAction
            open={confirmDeleteOpen}
            onOpenChange={setConfirmDeleteOpen}
            title="Delete source"
            body="Permanently delete this source and its routes?"
            confirmLabel="Delete"
            destructive
            onConfirm={() => deleteFormRef.current?.requestSubmit()}
          />
        </>
      ) : null}

      {errorMsg ? (
        <Alert variant="destructive" className="max-w-xs">
          <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
