"use client";

import { useActionState } from "react";
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
  const [state, action, pending] = useActionState<ActionState, FormData>(updateWorkspaceSettings, {});

  return (
    <form action={action} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="workspace-name">Name</Label>
        <Input
          id="workspace-name"
          name="workspaceName"
          defaultValue={name}
          disabled={!canEdit || pending}
          minLength={2}
          maxLength={80}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="workspace-timezone">Timezone</Label>
        <Select
          name="workspaceTimezone"
          defaultValue={timezone}
          disabled={!canEdit || pending}
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
      <Button type="submit" disabled={!canEdit || pending}>
        {pending ? "Saving…" : "Save workspace"}
      </Button>
    </form>
  );
}
