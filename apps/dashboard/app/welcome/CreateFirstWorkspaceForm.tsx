"use client";

import { useActionState } from "react";
import { createWorkspace } from "../../lib/workspace-team-actions";
import type { ActionState } from "../../lib/action-data";
import { TimezoneField } from "../_components/TimezoneField";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateFirstWorkspaceForm() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createWorkspace, {});
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      <TimezoneField />
      <div className="space-y-2">
        <Label htmlFor="workspaceName">Workspace name</Label>
        <Input id="workspaceName" name="workspaceName" autoFocus required minLength={2} maxLength={80} />
      </div>
      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
