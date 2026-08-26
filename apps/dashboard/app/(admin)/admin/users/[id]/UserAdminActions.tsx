"use client";

import { useActionState } from "react";
import {
  forceLogoutUserAction,
  impersonateUserAction,
  sendUserPasswordResetAction,
} from "../../../../../lib/admin-actions";
import type { ActionState } from "../../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "../../../../_components/ConfirmAction";

export function UserAdminActions({
  userId,
  email,
  isSuperAdmin,
  isSelf,
}: {
  userId: string;
  email: string;
  isSuperAdmin: boolean;
  isSelf: boolean;
}) {
  const [impersonateState, impersonateAction, impersonatePending] = useActionState<ActionState, FormData>(
    impersonateUserAction,
    {},
  );
  const [resetState, resetAction, resetPending] = useActionState<ActionState, FormData>(
    sendUserPasswordResetAction,
    {},
  );
  const [logoutState, logoutAction, logoutPending] = useActionState<ActionState, FormData>(
    forceLogoutUserAction,
    {},
  );

  const cannotImpersonate = isSuperAdmin || isSelf;

  return (
    <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Impersonate</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Sign in as this user for support work. A red banner stays visible until you stop.
          Session expires in 1 hour.
        </p>
        {cannotImpersonate ? (
          <p className="mt-3 text-xs italic text-muted-foreground">
            {isSelf ? "You can't impersonate yourself." : "Super-admins cannot be impersonated."}
          </p>
        ) : (
          <form action={impersonateAction} className="mt-3">
            <input type="hidden" name="user_id" value={userId} />
            {impersonateState.error ? (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{impersonateState.error}</AlertDescription>
              </Alert>
            ) : null}
            <ConfirmAction
              title="Impersonate user"
              body={`Impersonate ${email}? You'll be signed in as this user (audited, expires in 1 hour) until you stop.`}
              confirmLabel="Impersonate"
            >
              <Button type="button" disabled={impersonatePending}>
                {impersonatePending ? "Switching…" : `Impersonate ${email}`}
              </Button>
            </ConfirmAction>
          </form>
        )}
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Send password reset</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Emails a reset link to <strong>{email}</strong>. Link expires in 30 minutes.
        </p>
        <form action={resetAction} className="mt-3">
          <input type="hidden" name="user_id" value={userId} />
          {resetState.error ? (
            <Alert variant="destructive" className="mb-3">
              <AlertDescription>{resetState.error}</AlertDescription>
            </Alert>
          ) : null}
          {resetState.notice ? (
            <Alert className="mb-3">
              <AlertDescription>{resetState.notice}</AlertDescription>
            </Alert>
          ) : null}
          <Button type="submit" variant="secondary" disabled={resetPending}>
            {resetPending ? "Sending…" : "Send reset email"}
          </Button>
        </form>
      </div>

      <div className="rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold text-foreground">Force logout</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Revokes every active session. The user will need to sign in again.
        </p>
        {isSelf ? (
          <p className="mt-3 text-xs italic text-muted-foreground">
            You can't revoke your own sessions here.
          </p>
        ) : (
          <form action={logoutAction} className="mt-3">
            <input type="hidden" name="user_id" value={userId} />
            {logoutState.error ? (
              <Alert variant="destructive" className="mb-3">
                <AlertDescription>{logoutState.error}</AlertDescription>
              </Alert>
            ) : null}
            {logoutState.notice ? (
              <Alert className="mb-3">
                <AlertDescription>{logoutState.notice}</AlertDescription>
              </Alert>
            ) : null}
            <ConfirmAction
              title="Force logout"
              body="Revoke ALL sessions for this user? They'll be logged out everywhere."
              confirmLabel="Revoke sessions"
              destructive
            >
              <Button type="button" variant="destructive" disabled={logoutPending}>
                {logoutPending ? "Revoking…" : "Revoke all sessions"}
              </Button>
            </ConfirmAction>
          </form>
        )}
      </div>
    </section>
  );
}
