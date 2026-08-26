"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { backfillRoute, cancelBackfillJob } from "../../../../lib/route-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface ActiveJob {
  id: string;
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  total_estimated: number | null;
  enqueued: number;
  pending_replays: number;
  since: string;
  until: string;
  requested_at: string;
  error_message: string | null;
}

/**
 * AXE-66 v2 — backfill control on the route detail page. When a job is
 * active, shows progress and a cancel button. When no job is active,
 * shows the queue form.
 */
export function BackfillRouteForm({
  routeId,
  activeJob,
}: {
  routeId: string;
  activeJob: ActiveJob | null;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(backfillRoute, {});
  const [cancelState, cancelAction, cancelPending] = useActionState<ActionState, FormData>(
    cancelBackfillJob,
    {},
  );
  const [days, setDays] = useState("7");
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (state.notice || cancelState.notice) router.refresh();
  }, [state.notice, cancelState.notice, router]);

  // Poll for progress updates while a job is active. Cheap — just refreshes
  // the server component which re-fetches getActiveBackfillJob.
  useEffect(() => {
    if (!activeJob || activeJob.state === "done" || activeJob.state === "cancelled" || activeJob.state === "failed") {
      return;
    }
    const handle = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(handle);
  }, [activeJob, router]);

  if (activeJob && (activeJob.state === "pending" || activeJob.state === "running")) {
    const total = activeJob.total_estimated ?? 0;
    const percent = total > 0 ? Math.min(100, Math.round((activeJob.enqueued / total) * 100)) : null;
    return (
      <div className="space-y-3">
        {cancelState.error ? (
          <Alert variant="destructive">
            <AlertDescription>{cancelState.error}</AlertDescription>
          </Alert>
        ) : null}
        {cancelState.notice ? (
          <Alert>
            <AlertDescription>{cancelState.notice}</AlertDescription>
          </Alert>
        ) : null}

        <div className="rounded-md border border-input bg-muted/30 p-3">
          <div className="flex items-center justify-between gap-2">
            <strong className="text-sm font-semibold text-foreground">
              {activeJob.state === "pending" ? "Backfill queued" : "Backfill in progress"}
            </strong>
            <small className="font-mono text-xs text-muted-foreground">{activeJob.id}</small>
          </div>
          <div className="mt-2 space-y-1">
            <div className="flex items-baseline justify-between text-xs text-muted-foreground">
              <span>
                Enqueued {activeJob.enqueued.toLocaleString()}
                {total > 0 ? ` / ${total.toLocaleString()}` : ""}
                {percent !== null ? ` (${percent}%)` : ""}
              </span>
              <span>{activeJob.pending_replays.toLocaleString()} in flight</span>
            </div>
            {percent !== null ? (
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-foreground/80 transition-[width]"
                  style={{ width: `${percent}%` }}
                />
              </div>
            ) : null}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Window: {activeJob.since.slice(0, 10)} → {activeJob.until.slice(0, 10)}. Replays drain
            through the router at its natural rate — destinations won't be flooded.
          </p>
        </div>

        <form action={cancelAction}>
          <input type="hidden" name="job_id" value={activeJob.id} />
          <Button type="submit" variant="outline" size="sm" disabled={cancelPending}>
            {cancelPending ? "Cancelling…" : "Cancel backfill"}
          </Button>
          <p className="mt-1 text-xs text-muted-foreground">
            Already-enqueued replays will continue to deliver. Cancel just stops the worker from
            enqueueing more.
          </p>
        </form>
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
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}

      {activeJob && activeJob.state === "failed" ? (
        <Alert variant="destructive">
          <AlertDescription>
            Last backfill failed: {activeJob.error_message ?? "unknown error"}.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor={`backfill-window-${routeId}`}>Backfill window</Label>
          <Select name="backfill_days" value={days} onValueChange={setDays}>
            <SelectTrigger id={`backfill-window-${routeId}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 24 hours</SelectItem>
              <SelectItem value="3">Last 3 days</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="14">Last 14 days</SelectItem>
              <SelectItem value="30">Last 30 days (max)</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={pending || !confirmed}>
          {pending ? "Queuing…" : "Queue backfill"}
        </Button>
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 size-4 rounded border-input"
        />
        <span>
          I understand: each replayed event is a fresh delivery on the receiver's side. Running
          backfill twice queues duplicates. The worker shows progress here and throttles itself
          so the destination doesn't get flooded.
        </span>
      </label>
    </form>
  );
}
