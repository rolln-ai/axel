"use client";

import { Cookie } from "lucide-react";
import { CONSENT_PREFERENCES_EVENT } from "../../lib/consent";

/**
 * Re-opens the cookie-consent banner so a user can change or withdraw their
 * analytics choice at any time (Cookie Policy, Section 6).
 */
export function CookiePreferencesButton() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(CONSENT_PREFERENCES_EVENT))}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-accent/60 hover:text-foreground"
      aria-label="Cookie preferences"
    >
      <Cookie className="size-3.5" />
      <span>Cookie preferences</span>
    </button>
  );
}
