"use client";

import { useActionState, useState } from "react";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import { createWorkspace, switchWorkspace } from "../lib/workspace-team-actions";
import type { ActionState } from "../lib/action-data";
import type { WorkspaceMembership } from "../lib/session";
import { TimezoneField } from "./_components/TimezoneField";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function WorkspaceSwitcher({
  activeWorkspace,
  memberships,
}: {
  activeWorkspace: WorkspaceMembership;
  memberships: WorkspaceMembership[];
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createWorkspace, {});
  const workspaceInitial = (activeWorkspace.workspace_name[0] ?? ".").toUpperCase();

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-left outline-none transition hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
            aria-label="Workspace menu"
          >
            <span
              className="grid size-6 shrink-0 place-items-center rounded-sm bg-foreground text-[11px] font-medium text-background"
              aria-hidden="true"
            >
              {workspaceInitial}
            </span>
            <span className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="truncate text-sm font-medium">{activeWorkspace.workspace_name}</span>
              <span className="truncate text-[11px] text-muted-foreground capitalize">
                {activeWorkspace.role}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-56">
          <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">Workspaces</div>
          <div className="flex flex-col gap-px">
            {memberships.map((membership) => {
              const active = membership.workspace_id === activeWorkspace.workspace_id;
              return (
                <form key={membership.workspace_id} action={switchWorkspace}>
                  <input type="hidden" name="workspaceId" value={membership.workspace_id} />
                  <button
                    type="submit"
                    className={cn(
                      "flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm outline-none transition hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
                      active && "bg-accent/70 text-accent-foreground",
                    )}
                    disabled={active}
                  >
                    <span className="min-w-0 flex-1 truncate">{membership.workspace_name}</span>
                    {active ? <Check className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                  </button>
                </form>
              );
            })}
          </div>
          <DropdownMenuSeparator />
          <button
            type="button"
            className="flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left text-sm outline-none transition hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="size-4" aria-hidden="true" />
            <span>New workspace</span>
          </button>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New workspace</DialogTitle>
            <DialogDescription>
              Create a separate workspace for another product, environment, or team.
            </DialogDescription>
          </DialogHeader>
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
              {pending ? "Creating..." : "Create workspace"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
