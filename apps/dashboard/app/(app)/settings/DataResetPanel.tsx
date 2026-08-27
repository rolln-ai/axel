"use client";

import { useActionState, useMemo, useState } from "react";
import {
  deleteCurrentWorkspace,
  flushDestinationTargetData,
  wipeAllWorkspaceData,
  wipeWorkspaceSystemData,
} from "../../../lib/danger-zone-actions";
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
import { ConfirmAction } from "../../_components/ConfirmAction";

interface FlushableDestination {
  id: string;
  name: string;
  type: string;
  supported: boolean;
  detail: string;
}

export function DataResetPanel({
  workspaceName,
  role,
  isLastWorkspace,
  destinations,
}: {
  workspaceId: string;
  workspaceName: string;
  role: "owner" | "admin" | "member";
  isLastWorkspace: boolean;
  destinations: FlushableDestination[];
}) {
  const [wipeState, wipeAction, wipePending] = useActionState<ActionState, FormData>(wipeWorkspaceSystemData, {});
  const [flushState, flushAction, flushPending] = useActionState<ActionState, FormData>(flushDestinationTargetData, {});
  const [wipeAllState, wipeAllAction, wipeAllPending] = useActionState<ActionState, FormData>(wipeAllWorkspaceData, {});
  const [deleteState, deleteAction, deletePending] = useActionState<ActionState, FormData>(deleteCurrentWorkspace, {});
  const supportedDestinations = useMemo(() => destinations.filter((d) => d.supported), [destinations]);
  const unsupportedDestinations = useMemo(() => destinations.filter((d) => !d.supported), [destinations]);
  const [destinationId, setDestinationId] = useState(supportedDestinations[0]?.id ?? "");
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const selectedDestination = supportedDestinations.find((d) => d.id === destinationId) ?? null;
  const isOwner = role === "owner";
  const deleteNameMatches = deleteConfirmName.trim() === workspaceName;

  return (
    <div className="space-y-6">
      {!isOwner ? (
        <Alert>
          <AlertDescription>
            Only workspace owners can wipe event data or flush destination targets.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Flush target destination data</h2>
        </div>
        <form action={flushAction} className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">
            Optional external cleanup for destinations where Axel can identify the target table, collection, or volume. This does not remove destination configuration.
          </p>
          {supportedDestinations.length > 0 ? (
            <>
              <input type="hidden" name="destination_id" value={destinationId} />
              <div className="space-y-1.5">
                <Label htmlFor="destination-flush">Destination</Label>
                <Select value={destinationId} onValueChange={setDestinationId} disabled={!isOwner || flushPending}>
                  <SelectTrigger id="destination-flush" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {supportedDestinations.map((destination) => (
                      <SelectItem key={destination.id} value={destination.id}>
                        {destination.name} · {destination.type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedDestination ? (
                  <p className="text-xs text-muted-foreground">{selectedDestination.detail}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="destination-confirmation">Type flush to confirm</Label>
                <Input
                  id="destination-confirmation"
                  name="destination_confirmation"
                  placeholder="flush"
                  disabled={!isOwner || flushPending}
                  autoComplete="off"
                />
              </div>
            </>
          ) : (
            <Alert>
              <AlertDescription>No configured destinations currently support automated target flushing.</AlertDescription>
            </Alert>
          )}
          {unsupportedDestinations.length > 0 ? (
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Unsupported</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {unsupportedDestinations.map((destination) => (
                  <li key={destination.id}>
                    <span className="font-medium text-foreground">{destination.name}</span> · {destination.type}: {destination.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {flushState.error ? (
            <Alert variant="destructive"><AlertDescription>{flushState.error}</AlertDescription></Alert>
          ) : null}
          {flushState.notice ? (
            <Alert><AlertDescription>{flushState.notice}</AlertDescription></Alert>
          ) : null}
          <ConfirmAction
            title="Flush destination data"
            body="Flush data from the selected target destination? This modifies the external system."
            confirmLabel="Flush"
            destructive
          >
            <Button type="button" variant="destructive" disabled={!isOwner || flushPending || supportedDestinations.length === 0}>
              {flushPending ? "Flushing…" : "Flush selected destination"}
            </Button>
          </ConfirmAction>
        </form>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Wipe Axel event data</h2>
        </div>
        <form action={wipeAction} className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">
            Removes event analytics, delivery attempts, failed-delivery rows, replay requests, and idempotency rows for this workspace. Sources, routes, destinations, credentials, and members are preserved.
            Data Contract fixtures and drift records are removed; value-free structural schemas stay as configuration.
          </p>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="include_raw_payloads"
              className="mt-1 size-4 rounded border-border"
              disabled={!isOwner || wipePending}
            />
            <span>
              Also delete raw payload objects stored in Axel R2 when they are still discoverable from ClickHouse.
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="workspace-confirmation">Type wipe to confirm</Label>
            <Input
              id="workspace-confirmation"
              name="confirmation"
              placeholder="wipe"
              disabled={!isOwner || wipePending}
              autoComplete="off"
            />
          </div>
          {wipeState.error ? (
            <Alert variant="destructive"><AlertDescription>{wipeState.error}</AlertDescription></Alert>
          ) : null}
          {wipeState.notice ? (
            <Alert><AlertDescription>{wipeState.notice}</AlertDescription></Alert>
          ) : null}
          <ConfirmAction
            title="Wipe event data"
            body="Wipe all event history for this workspace? Sources, routes, and destinations stay intact."
            confirmLabel="Wipe"
            destructive
          >
            <Button type="button" variant="destructive" disabled={!isOwner || wipePending}>
              {wipePending ? "Wiping…" : "Wipe Axel event data"}
            </Button>
          </ConfirmAction>
        </form>
      </section>

      <section className="rounded-lg border border-destructive/40 bg-card">
        <div className="border-b border-destructive/20 px-5 py-3">
          <h2 className="text-sm font-semibold text-destructive">Wipe all data</h2>
        </div>
        <form action={wipeAllAction} className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">
            Runs the Axel event-data wipe with raw payload deletion, then flushes every supported destination target above. Unsupported destination types are skipped.
          </p>
          <label className="flex items-start gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              name="pause_sources"
              defaultChecked
              className="mt-1 size-4 rounded border-border"
              disabled={!isOwner || wipeAllPending}
            />
            <span>
              Pause all sources first so new webhook traffic cannot recreate event data while the wipe runs.
            </span>
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="wipe-all-confirmation">Type wipe all to confirm</Label>
            <Input
              id="wipe-all-confirmation"
              name="confirmation"
              placeholder="wipe all"
              disabled={!isOwner || wipeAllPending}
              autoComplete="off"
            />
          </div>
          {wipeAllState.error ? (
            <Alert variant="destructive"><AlertDescription>{wipeAllState.error}</AlertDescription></Alert>
          ) : null}
          {wipeAllState.notice ? (
            <Alert><AlertDescription>{wipeAllState.notice}</AlertDescription></Alert>
          ) : null}
          <ConfirmAction
            title="Wipe all data"
            body="Wipe Axel event data and flush every supported target destination? Configuration stays intact."
            confirmLabel="Wipe all"
            destructive
          >
            <Button type="button" variant="destructive" disabled={!isOwner || wipeAllPending}>
              {wipeAllPending ? "Wiping all…" : "Wipe all data"}
            </Button>
          </ConfirmAction>
        </form>
      </section>

      <section className="rounded-lg border border-destructive/40 bg-card">
        <div className="border-b border-destructive/20 px-5 py-3">
          <h2 className="text-sm font-semibold text-destructive">Delete this workspace</h2>
        </div>
        <form action={deleteAction} className="space-y-4 p-5">
          <p className="text-sm text-muted-foreground">
            Permanently deletes <span className="font-medium text-foreground">{workspaceName}</span> and clears
            everything in it: event history, delivery attempts, dead letters, replay history, and stored raw payloads,
            plus all sources, routes, destinations, credentials, API keys, and member access. This is irreversible.
          </p>
          <p className="text-xs text-muted-foreground">
            Data already delivered to your external destinations is left untouched — use “Wipe all data” above to flush
            those targets first.
          </p>
          {isLastWorkspace ? (
            <Alert>
              <AlertDescription>
                Deleting this leaves you with no active workspace — you&apos;ll be taken to a screen to create a new one.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm-name">
              Type <span className="font-medium text-foreground">{workspaceName}</span> to confirm
            </Label>
            <Input
              id="delete-confirm-name"
              name="confirm_name"
              placeholder={workspaceName}
              value={deleteConfirmName}
              onChange={(event) => setDeleteConfirmName(event.target.value)}
              disabled={!isOwner || deletePending}
              autoComplete="off"
            />
          </div>
          {deleteState.error ? (
            <Alert variant="destructive"><AlertDescription>{deleteState.error}</AlertDescription></Alert>
          ) : null}
          <ConfirmAction
            title="Delete workspace"
            body={`Permanently delete "${workspaceName}" and clear all of its data? This cannot be undone.`}
            confirmLabel="Delete workspace"
            destructive
          >
            <Button
              type="button"
              variant="destructive"
              disabled={!isOwner || deletePending || !deleteNameMatches}
            >
              {deletePending ? "Deleting…" : "Delete workspace"}
            </Button>
          </ConfirmAction>
        </form>
      </section>
    </div>
  );
}
