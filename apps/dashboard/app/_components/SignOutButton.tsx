"use client";

import { LogOut } from "lucide-react";
import posthog from "posthog-js";
import { logOut } from "../../lib/auth-actions";

/**
 * Sign-out control. Calls `posthog.reset()` before the server action runs so
 * the next person on this browser starts as a fresh anonymous visitor instead
 * of inheriting the previous user's PostHog identity. `reset()` only touches
 * local SDK state, so it's safe to fire before the redirect.
 */
export function SignOutButton() {
  return (
    <form action={logOut}>
      <button
        type="submit"
        onClick={() => posthog.reset()}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
        aria-label="Sign out"
      >
        <LogOut className="size-3.5" />
        <span>Sign out</span>
      </button>
    </form>
  );
}
