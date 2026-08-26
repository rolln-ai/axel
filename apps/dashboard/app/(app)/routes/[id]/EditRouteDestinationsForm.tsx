"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateRouteDestinations } from "../../../../lib/route-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DestinationBindingPicker } from "../DestinationBindingPicker";

interface DestinationOpt {
  id: string;
  name: string | null;
  type: string;
  status: "active" | "disabled";
}

export function EditRouteDestinationsForm({
  routeId,
  sourceId,
  destinations,
  selectedDestinationIds,
  bindingsByDestinationId,
}: {
  routeId: string;
  /** The route's source id — enables the BigQuery pre-flight compatibility check. */
  sourceId?: string;
  destinations: DestinationOpt[];
  selectedDestinationIds: string[];
  /** Existing per-destination bindings keyed by destination_id. Used to
   *  prefill the inline binding picker so editors see the current state. */
  bindingsByDestinationId?: Record<string, Record<string, unknown>>;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateRouteDestinations,
    {},
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectedDestinationIds),
  );

  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  if (destinations.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-5 text-center">
        <strong className="block text-sm font-semibold text-foreground">
          No destinations available.
        </strong>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a destination before editing this route.
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="route_id" value={routeId} />

      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice && !state.error ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-2">
        <div className="divide-y divide-border/50">
          {destinations.map((d) => {
            const isSelected = selected.has(d.id);
            return (
              <div key={d.id} className="py-1 first:pt-0 last:pb-0">
                <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted">
                  <input
                    type="checkbox"
                    name="destination_ids"
                    value={d.id}
                    defaultChecked={selectedDestinationIds.includes(d.id)}
                    className="size-4 rounded border-input"
                    onChange={(e) => {
                      setSelected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(d.id);
                        else next.delete(d.id);
                        return next;
                      });
                    }}
                  />
                  <span className="flex-1 text-sm text-foreground">
                    {d.name ?? "(unnamed)"}{" "}
                    <span className="text-xs text-muted-foreground">
                      - {d.type} ({d.id})
                      {d.status === "disabled" ? " - disabled" : ""}
                    </span>
                  </span>
                </label>
                {isSelected ? (
                  <div className="mt-1.5 pl-6">
                    <DestinationBindingPicker
                      destinationId={d.id}
                      destinationType={d.type}
                      destinationName={d.name ?? d.id}
                      initialBinding={bindingsByDestinationId?.[d.id]}
                      sourceId={sourceId}
                    />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Each event fans out to every selected destination. Pick the write target per destination.
        </p>
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? "Saving..." : "Save destinations"}
      </Button>
    </form>
  );
}
