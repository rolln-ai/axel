"use client";

import { useActionState } from "react";
import { signUp } from "../../lib/auth-actions";
import type { ActionState } from "../../lib/action-data";
import { CONSENT_DOCUMENTS } from "../../lib/legal";
import { PasswordInput } from "../_components/PasswordInput";
import { TimezoneField } from "../_components/TimezoneField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function SignupForm({ inviteToken }: { inviteToken?: string | undefined }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(signUp, {});
  // Public signups end in the same "check your email" notice whether the
  // address was new or already registered (anti-enumeration). Swap the form
  // for the notice so there's nothing left to resubmit.
  if (state.notice) {
    return (
      <Alert>
        <AlertDescription>{state.notice}</AlertDescription>
      </Alert>
    );
  }
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {inviteToken ? <input type="hidden" name="inviteToken" value={inviteToken} /> : <TimezoneField />}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" name="name" autoComplete="name" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Work email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="workspaceName">Workspace name</Label>
        <Input
          id="workspaceName"
          name="workspaceName"
          required={!inviteToken}
          disabled={Boolean(inviteToken)}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </div>
      <div className="flex items-start gap-2">
        <input
          id="acceptTerms"
          name="acceptTerms"
          type="checkbox"
          required
          className="mt-0.5 size-4 shrink-0 rounded border-input accent-primary"
        />
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
          <Label htmlFor="acceptTerms" className="text-xs font-normal">
            I agree to Axel&apos;s:
          </Label>
          <ul className="space-y-0.5">
            {CONSENT_DOCUMENTS.map((doc) => (
              <li key={doc.slug}>
                <a
                  href={doc.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2 hover:no-underline"
                >
                  {doc.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating..." : inviteToken ? "Join workspace" : "Create workspace"}
      </Button>
    </form>
  );
}
