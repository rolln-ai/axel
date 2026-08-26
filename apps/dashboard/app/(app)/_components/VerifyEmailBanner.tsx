"use client";

import { type FormEvent, useEffect, useState } from "react";
import type { ActionState } from "../../../lib/action-data";

/**
 * Persistent notice above (app) page content while the signed-in user's
 * email is unverified. Deliberately a notice, not a gate — Axel favors
 * low-friction onboarding, so the dashboard stays fully usable and this
 * banner (plus the resend button) is the nudge. Verifying via the emailed
 * link stamps users.email_verified_at and the banner disappears.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [state, setState] = useState<ActionState>({});
  const [pending, setPending] = useState(false);

  // A non-hydrated form submission uses the route's redirect fallback. Turn
  // that compact status into the same inline notice once the page hydrates.
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("verification-email");
    if (!result) return;
    setState(
      result === "sent"
        ? { notice: `Verification email sent to ${email}. The link expires in 24 hours.` }
        : { error: "Could not send the verification email. Try again." },
    );
    url.searchParams.delete("verification-email");
    window.history.replaceState(window.history.state, "", url);
  }, [email]);

  async function resend(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setPending(true);
    setState({});
    try {
      const response = await fetch("/api/auth/resend-verification", {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const body = (await response.json().catch(() => ({}))) as ActionState;
      if (!response.ok && !body.error) {
        setState({ error: "Could not send the verification email. Try again." });
      } else {
        setState(body);
      }
    } catch {
      setState({ error: "Could not send the verification email. Check your connection and try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-500/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
      <div>
        <strong className="font-semibold">Verify your email.</strong>{" "}
        {state.error ??
          state.notice ??
          `We sent a confirmation link to ${email} — verifying keeps password recovery and alert delivery working.`}
      </div>
      <form action="/api/auth/resend-verification" method="post" onSubmit={resend}>
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-current px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:opacity-80 disabled:opacity-50"
        >
          {pending ? "Sending..." : "Resend email"}
        </button>
      </form>
    </div>
  );
}
