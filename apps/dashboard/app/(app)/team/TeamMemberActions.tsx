"use client";

import { useActionState } from "react";
import { changeMemberRoleAction, removeMemberAction } from "../../../lib/workspace-team-actions";
import type { ActionState } from "../../../lib/action-data";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "../../_components/ConfirmAction";
import { useActionStateToast } from "../../_components/Toast";

/**
 * Per-row member management: change role + remove. Owner-role options are only
 * offered when the viewer is an owner; the server re-checks every guard
 * (owner-only owner changes, last-owner protection) and the result/error is
 * surfaced inline (the page previously had NO member lifecycle controls at all).
 */
export function TeamMemberActions({
  userId,
  currentRole,
  canManageOwners,
  isSelf,
}: {
  userId: string;
  currentRole: "owner" | "admin" | "member";
  canManageOwners: boolean;
  /** Row belongs to the signed-in user — removal ends their own access. */
  isSelf: boolean;
}) {
  const [roleState, roleAction, rolePending] = useActionState<ActionState, FormData>(
    changeMemberRoleAction,
    {},
  );
  const [removeState, removeAction, removePending] = useActionState<ActionState, FormData>(
    removeMemberAction,
    {},
  );
  const error = roleState.error || removeState.error;
  // Transient success outcomes surface as toasts; errors stay inline below.
  useActionStateToast({ notice: roleState.notice });
  useActionStateToast({ notice: removeState.notice });

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <form action={roleAction} className="flex items-center gap-1.5">
          <input type="hidden" name="user_id" value={userId} />
          <select
            name="role"
            defaultValue={currentRole}
            aria-label="Member role"
            className="rounded-md border border-border bg-background px-2 py-1 text-xs capitalize"
          >
            <option value="member">member</option>
            <option value="admin">admin</option>
            {canManageOwners || currentRole === "owner" ? (
              <option value="owner">owner</option>
            ) : null}
          </select>
          <Button type="submit" size="sm" variant="ghost" disabled={rolePending}>
            {rolePending ? "Saving…" : "Save"}
          </Button>
        </form>
        <form action={removeAction}>
          <input type="hidden" name="user_id" value={userId} />
          <ConfirmAction
            title="Remove member"
            body={
              isSelf
                ? "Remove YOURSELF from this workspace? You lose access immediately and need a new invite to get back in."
                : "Remove this member from the workspace? They lose access immediately."
            }
            confirmLabel="Remove"
            destructive
          >
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              disabled={removePending}
            >
              {removePending ? "Removing…" : "Remove"}
            </Button>
          </ConfirmAction>
        </form>
      </div>
      {error ? (
        <span role="alert" className="text-[11px] text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  );
}
