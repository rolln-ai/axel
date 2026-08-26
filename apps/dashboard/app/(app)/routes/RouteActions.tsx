"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { deleteRoute, setRouteStatus } from "../../../lib/route-actions";
import type { ActionState } from "../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { useActionStateToast } from "../../_components/Toast";

export function RouteActions({
  routeId,
  status,
  canDelete,
}: {
  routeId: string;
  status: "active" | "disabled" | "errored";
  canDelete: boolean;
}) {
  const router = useRouter();
  const [statusState, statusAction, statusPending] = useActionState<ActionState, FormData>(setRouteStatus, {});
  const [deleteState, deleteAction, deletePending] = useActionState<ActionState, FormData>(deleteRoute, {});

  useEffect(() => {
    if (statusState.notice && !statusState.error) router.refresh();
  }, [statusState.notice, statusState.error, router]);
  useEffect(() => {
    if (deleteState.notice && !deleteState.error) {
      // The detail page for this route is now a 404; land the operator on
      // the routes list instead of refreshing into a dead page.
      router.push("/routes");
      router.refresh();
    }
  }, [deleteState.notice, deleteState.error, router]);

  // Transient success outcomes surface as toasts; errors stay inline below.
  useActionStateToast({ notice: statusState.notice });
  useActionStateToast({ notice: deleteState.notice });

  const targetStatus = status === "active" ? "disabled" : "active";
  const targetLabel = status === "active" ? "Disable" : "Enable";
  const errorMsg = statusState.error ?? deleteState.error;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form action={statusAction}>
        <input type="hidden" name="route_id" value={routeId} />
        <input type="hidden" name="status" value={targetStatus} />
        <Button type="submit" variant="outline" size="sm" disabled={statusPending}>
          {statusPending ? "Working…" : targetLabel}
        </Button>
      </form>

      {canDelete ? (
        <form action={deleteAction}>
          <input type="hidden" name="route_id" value={routeId} />
          <ConfirmAction
            title="Delete route"
            body={`Permanently delete route ${routeId}?`}
            confirmLabel="Delete"
            destructive
          >
            <Button type="button" variant="destructive" size="sm" disabled={deletePending}>
              {deletePending ? "Deleting…" : "Delete"}
            </Button>
          </ConfirmAction>
        </form>
      ) : null}

      {errorMsg ? (
        <Alert variant="destructive" className="w-full">
          <AlertDescription className="text-xs">{errorMsg}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
