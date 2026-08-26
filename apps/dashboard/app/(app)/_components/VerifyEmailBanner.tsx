"use client";

import { useActionState } from "react";
import { resendVerificationEmail } from "../../../lib/auth-actions";
import type { ActionState } from "../../../lib/action-data";

/**
 * Persistent notice above (app) page content while the signed-in user's
 * email is unverified. Deliberately a notice, not a gate — Axel favors
 * low-friction onboarding, so the dashboard stays fully usable and this
 * banner (plus the resend button) is the nudge. Verifying via the emailed
 * link stamps users.email_verified_at and the banner disappears.
 */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    resendVerificationEmail,
    {},
  );
  return (
    <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-amber-500/60 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-950/40 dark:text-amber-200">
      <div>
        <strong className="font-semibold">Verify your email.</strong>{" "}
        {state.error ??
          state.notice ??
          `We sent a confirmation link to ${email} — verifying keeps password recovery and alert delivery working.`}
      </div>
      <form action={formAction}>
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
