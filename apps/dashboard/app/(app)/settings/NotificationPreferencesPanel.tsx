"use client";

import { useActionState } from "react";
import { updateNotificationPreferencesAction } from "../../../lib/workspace-team-actions";
import type { ActionState } from "../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * Per-user notification email preferences. In-app notifications are never
 * suppressed — these toggles only decide which emails the user receives.
 */
export function NotificationPreferencesPanel({
  current,
}: {
  current: { email_digest_daily: boolean; email_immediate: boolean };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateNotificationPreferencesAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose which emails you get. You&apos;ll always see every notification in the
        in-app bell — these settings only control email.
      </p>
      <PreferenceToggle
        name="email_immediate"
        label="Immediate alerts"
        hint="Email me as soon as something needs attention — like a new error type that starts failing deliveries. Repeats are de-duplicated, so a problem that happens 100 times is still just one email."
        defaultChecked={current.email_immediate}
      />
      <PreferenceToggle
        name="email_digest_daily"
        label="Daily digest"
        hint="A once-a-day summary of everything else — usage and billing notices, best-practice nudges, and anything you weren't alerted about immediately."
        defaultChecked={current.email_digest_daily}
      />
      {state.error ? (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      {state.notice ? (
        <Alert><AlertDescription>{state.notice}</AlertDescription></Alert>
      ) : null}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? "Saving…" : "Save preferences"}
        </Button>
      </div>
    </form>
  );
}

function PreferenceToggle({
  name,
  label,
  hint,
  defaultChecked,
}: {
  name: string;
  label: string;
  hint: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex items-start gap-3 rounded-md border border-border p-3">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="mt-1 size-4 rounded border-border"
      />
      <div className="space-y-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-[11px] text-muted-foreground">{hint}</span>
      </div>
    </label>
  );
}
