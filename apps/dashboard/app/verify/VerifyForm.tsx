"use client";

import { useActionState } from "react";
import { verifyEmail } from "../../lib/auth-actions";
import type { ActionState } from "../../lib/action-data";
import { ScrubQueryParameter } from "../_components/ScrubQueryParameter";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function VerifyForm({ token }: { token: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(verifyEmail, {});
  return (
    <form action={formAction} className="space-y-4">
      <ScrubQueryParameter name="token" />
      <input type="hidden" name="token" value={token} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Confirming..." : "Confirm email"}
      </Button>
    </form>
  );
}
