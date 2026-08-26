"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  CONSENT_PREFERENCES_EVENT,
  consentDecisionPending,
  disableAnalytics,
  enableAnalytics,
  writeConsent,
} from "../../lib/consent";

/**
 * Cookie-consent banner. Shows only when consent is required (EEA/UK/CH or
 * unknown geo) and the user hasn't decided yet — or when re-opened via the
 * "Cookie preferences" control. Accepting starts PostHog; declining keeps it
 * off and clears any analytics cookies.
 */
export function CookieConsent() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (consentDecisionPending()) setOpen(true);
    const reopen = () => setOpen(true);
    window.addEventListener(CONSENT_PREFERENCES_EVENT, reopen);
    return () => window.removeEventListener(CONSENT_PREFERENCES_EVENT, reopen);
  }, []);

  if (!open) return null;

  const accept = () => {
    writeConsent("granted");
    enableAnalytics();
    setOpen(false);
  };
  const decline = () => {
    writeConsent("denied");
    disableAnalytics();
    setOpen(false);
  };

  return (
    <div
      role="dialog"
      aria-label="Cookie consent"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex justify-center p-4"
    >
      <div className="pointer-events-auto flex w-full max-w-2xl flex-wrap items-center gap-4 rounded-xl border bg-background/95 px-5 py-4 shadow-2xl backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <p className="flex-1 basis-80 text-xs leading-relaxed text-muted-foreground">
          We use a privacy-friendly analytics cookie (PostHog) to see how Axel is used and improve it.
          Strictly-necessary cookies always run. Read our{" "}
          <a
            href="https://axelapp.ai/cookies"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-foreground underline underline-offset-2"
          >
            Cookie Policy
          </a>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={decline}>
            Decline
          </Button>
          <Button type="button" size="sm" onClick={accept}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
