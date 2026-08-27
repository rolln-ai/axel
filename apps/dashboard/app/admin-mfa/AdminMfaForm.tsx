"use client";

import { useActionState } from "react";
import {
  beginAdminMfaEnrollmentAction,
  verifyAdminMfaAction,
} from "../../lib/admin-mfa-actions";
import type { ActionState } from "../../lib/action-data";
import { PasswordInput } from "../_components/PasswordInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminMfaEnrollmentForm({ returnTo }: { returnTo?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    beginAdminMfaEnrollmentAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <div className="space-y-2">
        <Label htmlFor="admin-mfa-password">Current password</Label>
        <PasswordInput
          id="admin-mfa-password"
          name="password"
          autoComplete="current-password"
          required
        />
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Checking password..." : "Set up authenticator"}
      </Button>
    </form>
  );
}

export function AdminMfaCodeForm({ returnTo }: { returnTo?: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    verifyAdminMfaAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <div className="space-y-2">
        <Label htmlFor="admin-mfa-code">Authenticator code</Label>
        <Input
          id="admin-mfa-code"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          autoFocus
          className="font-mono tracking-[0.35em]"
        />
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Verifying..." : "Continue to admin"}
      </Button>
    </form>
  );
}
