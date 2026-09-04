"use client";

import { useEffect, useState, type FormEvent } from "react";
import { updateWorkspaceSettings } from "../../../lib/workspace-team-actions";
import type { ActionState } from "../../../lib/action-data";
import { WORKSPACE_TIMEZONE_OPTIONS } from "../../../lib/timezones";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function WorkspaceSettingsForm({
  name,
  timezone,
  workspaceId,
  canEdit,
}: {
  name: string;
  timezone: string;
  workspaceId: string;
  canEdit: boolean;
}) {
  const [state, setState] = useState<ActionState>({});
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  // Keep completion state outside the router's refresh transition. In production
  // builds, useActionState could stay pending after the successful response arrived.
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const formData = new FormData(event.currentTarget);
    setPending(true);
    try {
      setState(await updateWorkspaceSettings({}, formData));
    } catch {
      setState({ error: "Could not confirm the update. Reload to check the saved settings." });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Name</Label>
        <Input
          id="workspace-name"
          name="workspaceName"
          defaultValue={name}
          disabled={!ready || !canEdit || pending}
          minLength={2}
          maxLength={80}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="workspace-timezone">Timezone</Label>
        <Select
          name="workspaceTimezone"
          defaultValue={timezone}
          disabled={!ready || !canEdit || pending}
        >
          <SelectTrigger id="workspace-timezone" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WORKSPACE_TIMEZONE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label} ({option.value})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Used for workspace usage charts and daily reporting.
        </p>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Workspace ID</p>
        <code className="block w-fit rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
          {workspaceId}
        </code>
      </div>
      {state.error ? (
        <Alert variant="destructive"><AlertDescription>{state.error}</AlertDescription></Alert>
      ) : null}
      {state.notice ? (
        <Alert><AlertDescription>{state.notice}</AlertDescription></Alert>
      ) : null}
      <Button type="submit" disabled={!ready || !canEdit || pending}>
        {pending ? "Saving…" : "Save workspace"}
      </Button>
    </form>
  );
}
