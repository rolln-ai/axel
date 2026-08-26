"use client";

import Link from "next/link";
import { useActionState } from "react";
import { signIn } from "../../lib/auth-actions";
import type { ActionState } from "../../lib/action-data";
import { PasswordInput } from "../_components/PasswordInput";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm({ returnTo }: { returnTo?: string | undefined }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(signIn, {});
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {/* Where the auth gate bounced the user from; signIn re-validates it
          server-side before honoring it, so tampering only costs the round-trip. */}
      {returnTo ? <input type="hidden" name="returnTo" value={returnTo} /> : null}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link
            href="/forgot"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Forgot?
          </Link>
        </div>
        <PasswordInput
          id="password"
          name="password"
          autoComplete="current-password"
          required
        />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Signing in..." : "Sign in"}
      </Button>
    </form>
  );
}
