"use client";

import { useActionState, useState } from "react";
import { inviteMember } from "../../../lib/workspace-team-actions";
import type { ActionState } from "../../../lib/action-data";
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

export function InviteForm() {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(inviteMember, {});
  const [role, setRole] = useState<"member" | "admin">("member");
  return (
    <form action={formAction} className="space-y-4">
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 md:grid-cols-[1fr_180px_auto] md:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="invite-email">Email</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            placeholder="teammate@example.com"
            required
            autoComplete="off"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <input type="hidden" name="role" value={role} />
          <Select value={role} onValueChange={(value) => setRole(value as "member" | "admin")}>
            <SelectTrigger id="invite-role" className="w-full">
              <SelectValue placeholder="Select role" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="member">Member</SelectItem>
              <SelectItem value="admin">Admin</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </div>
    </form>
  );
}
