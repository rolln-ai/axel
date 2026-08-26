"use client";

import { useActionState } from "react";
import { cancelInviteAction } from "../../../lib/workspace-team-actions";
import type { ActionState } from "../../../lib/action-data";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { useActionStateToast } from "../../_components/Toast";

/** Cancel a pending invite (confirmation-gated; the link stops working). */
export function CancelInviteButton({ inviteId }: { inviteId: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    cancelInviteAction,
    {},
  );
  // Transient success outcome — previously dropped on the floor.
  useActionStateToast({ notice: state.notice });
  return (
    <div className="flex items-center justify-end gap-2">
      {state.error ? (
        <span role="alert" className="text-[11px] text-destructive">
          {state.error}
        </span>
      ) : null}
      <form action={action}>
        <input type="hidden" name="invite_id" value={inviteId} />
        <ConfirmAction
          title="Cancel invite"
          body="Cancel this invite? The link will stop working."
          confirmLabel="Cancel invite"
          cancelLabel="Keep invite"
          destructive
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            disabled={pending}
          >
            {pending ? "Canceling…" : "Cancel"}
          </Button>
        </ConfirmAction>
      </form>
    </div>
  );
}
