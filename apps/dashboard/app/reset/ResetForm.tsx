"use client";

import { useActionState } from "react";
import { resetPassword } from "../../lib/auth-actions";
import type { ActionState } from "../../lib/action-data";
import { PasswordInput } from "../_components/PasswordInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function ResetForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(resetPassword, {});
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="token" value={token} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="space-y-2">
        <Label htmlFor="password">New password</Label>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirm new password</Label>
        <PasswordInput
          id="confirm"
          name="confirm"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Saving..." : "Set new password"}
      </Button>
    </form>
  );
}
