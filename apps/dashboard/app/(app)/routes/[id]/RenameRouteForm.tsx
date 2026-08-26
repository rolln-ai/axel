"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { renameRoute } from "../../../../lib/route-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Inline "rename this pipeline" control on the route detail page. Posts to the
 * `renameRoute` server action and refreshes so the header + list reflect the new
 * name. The input is keyed on `currentName` so a successful rename re-seeds it.
 */
export function RenameRouteForm({
  routeId,
  currentName,
}: {
  routeId: string;
  currentName: string | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(renameRoute, {});

  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  return (
    <form action={formAction} className="space-y-1.5">
      <input type="hidden" name="route_id" value={routeId} />
      <Label htmlFor="route-name">Pipeline name</Label>
      <div className="flex gap-2">
        <Input
          key={currentName ?? ""}
          id="route-name"
          name="name"
          defaultValue={currentName ?? ""}
          placeholder="chargebee-prod-to-mongo"
          minLength={2}
          maxLength={64}
          required
          autoComplete="off"
          spellCheck={false}
          className="h-9 flex-1"
        />
        <Button type="submit" variant="outline" size="sm" className="h-9 sm:w-28" disabled={pending}>
          {pending ? "Saving…" : "Rename"}
        </Button>
      </div>
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : state.notice ? (
        <p className="text-xs text-emerald-600 dark:text-emerald-500">{state.notice}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          2–64 characters: letters, numbers, spaces, and . _ -
        </p>
      )}
    </form>
  );
}
