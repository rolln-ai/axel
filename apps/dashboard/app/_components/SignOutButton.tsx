"use client";

import { LogOut } from "lucide-react";
import { logOut } from "../../lib/auth-actions";

export function SignOutButton() {
  return (
    <form action={logOut}>
      <button
        type="submit"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
        aria-label="Sign out"
      >
        <LogOut className="size-3.5" />
        <span>Sign out</span>
      </button>
    </form>
  );
}
