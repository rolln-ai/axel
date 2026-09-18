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
  current: { email_schema_weekly: boolean; email_immediate: boolean };
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(
    updateNotificationPreferencesAction,
    {},
  );
  return (
    <form action={action} className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Choose which emails you get for this workspace. Active incidents remain visible in the Inbox.
      </p>
      <PreferenceToggle
        name="email_immediate"
        label="Data flow incidents"
        hint="Alert me when an established source stops receiving data or delivery is blocked. One email per incident, reminders at most once a day, and a recovery notice. Acknowledge in the Inbox to pause reminders for 24 hours."
        defaultChecked={current.email_immediate}
      />
      <PreferenceToggle
        name="email_schema_weekly"
        label="Weekly schema observations"
        hint="Optional Monday summary of observed schema changes. Off by default. These observations do not prove that data is flowing or that destination storage is compatible."
        defaultChecked={current.email_schema_weekly}
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
