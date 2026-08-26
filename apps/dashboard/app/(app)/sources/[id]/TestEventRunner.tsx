"use client";

import * as React from "react";
import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Play, AlertCircle, CheckCircle, Loader2, XCircle } from "lucide-react";
import {
  sendTestEvent,
  getTestEventOutcome,
  type TestEventOutcome,
} from "../../../../lib/test-event-actions";
import type { ActionState } from "../../../../lib/action-data";
import { GENERIC_SAMPLE } from "../../../../lib/test-payloads";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

/**
 * AXE-25 — the load-bearing "send a test event, then poll its REAL routing /
 * delivery outcome" logic, extracted so it lives in exactly one place. Both
 * the source-detail SendTestEventDialog (rich payload editor) and the new
 * first-run wizard activation step share this poll loop + inspector, instead
 * of two copies drifting apart.
 *
 * The send goes through the real ingest path flagged is_test, so it routes
 * and delivers exactly like a real event. After a successful send we poll
 * getTestEventOutcome() to surface which routes matched and what each
 * destination returned — a pipeline with zero routes or a broken destination
 * shows up clearly here, before go-live.
 */

// Poll cadence — the router + delivery pipeline is async, so the outcome
// trickles in over a few seconds. ~8 tries at 1.2s covers the common case
// without hammering ClickHouse or hanging the dialog open indefinitely.
const POLL_INTERVAL_MS = 1200;
const POLL_MAX_TRIES = 8;

export type InspectorState =
  | { phase: "idle" }
  | { phase: "polling"; eventId: string; tries: number; outcome: TestEventOutcome | null }
  | { phase: "done"; eventId: string; outcome: TestEventOutcome }
  | { phase: "error"; eventId: string; message: string };

/**
 * Drives the outcome poll off a sendTestEvent action-state. Returns the
 * current inspector phase plus a `reset()` to clear it (e.g. a Reset button).
 * Kicks off at most one poll loop per distinct sent event.
 */
export function useTestEventPoll(
  state: ActionState,
  { refresh = true }: { refresh?: boolean } = {},
): {
  inspector: InspectorState;
  reset: () => void;
} {
  const router = useRouter();
  const [inspector, setInspector] = useState<InspectorState>({ phase: "idle" });
  // Guards against double-starting the poll loop for the same send (the
  // action state object identity changes on each submit).
  const polledEventId = useRef<string | null>(null);

  useEffect(() => {
    if (state.error) {
      setInspector({ phase: "idle" });
      polledEventId.current = null;
      return;
    }
    const eventId = state.data?.eventId;
    if (!state.notice || !eventId) return;
    // Only kick off polling once per distinct send.
    if (polledEventId.current === eventId) return;
    polledEventId.current = eventId;
    // Refresh the surrounding page (e.g. the source-detail event list) after a
    // send. Skipped when the runner lives inside a modal that is gated on a
    // server condition (the first-run wizard), where a refresh would unmount
    // the dialog mid-flow.
    if (refresh) router.refresh();

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    setInspector({ phase: "polling", eventId, tries: 0, outcome: null });

    const poll = async (tries: number) => {
      const res = await getTestEventOutcome(eventId).catch(
        (err): { error: string } => ({
          error: err instanceof Error ? err.message : "Failed to read test-event result.",
        }),
      );
      if (cancelled) return;

      if ("error" in res) {
        setInspector({ phase: "error", eventId, message: res.error });
        return;
      }

      const outcome = res.outcome;
      // Stop early once we have a settled result (a route matched and
      // every matched route has produced at least one delivery attempt),
      // otherwise keep polling until we run out of tries.
      const settled = outcome.any_matched && outcome.any_delivered;
      const nextTries = tries + 1;
      if (settled || nextTries >= POLL_MAX_TRIES) {
        setInspector({ phase: "done", eventId, outcome });
        return;
      }
      setInspector({ phase: "polling", eventId, tries: nextTries, outcome });
      timer = setTimeout(() => void poll(nextTries), POLL_INTERVAL_MS);
    };

    // Small initial delay so the pipeline has a beat to write its first rows.
    timer = setTimeout(() => void poll(0), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state, router, refresh]);

  const reset = React.useCallback(() => {
    setInspector({ phase: "idle" });
    polledEventId.current = null;
  }, []);

  return { inspector, reset };
}

/**
 * Self-contained "Send test event" control: a one-button form (no payload
 * editor) plus the live outcome inspector. Used by the first-run wizard's
 * activation step. Power users get the full editor in SendTestEventDialog.
 */
export function TestEventRunner({
  sourceId,
  defaultPayload = GENERIC_SAMPLE,
  onSent,
}: {
  sourceId: string;
  defaultPayload?: unknown;
  /** Called once per successful send — lets a host flow (e.g. first-run
   *  setup) mark its "first event" step complete even when ClickHouse (and
   *  so the ingest monitor) is unavailable. */
  onSent?: () => void;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(sendTestEvent, {});
  // refresh:false — this runner lives inside the first-run wizard modal, which
  // is rendered inside a server-gated empty-state branch; a router.refresh()
  // here would re-render the page and unmount the dialog mid-flow.
  const { inspector } = useTestEventPoll(state, { refresh: false });
  const payloadStr = React.useMemo(() => JSON.stringify(defaultPayload), [defaultPayload]);
  const onSentRef = useRef(onSent);
  useEffect(() => {
    onSentRef.current = onSent;
  });
  const notifiedEventId = useRef<string | null>(null);
  useEffect(() => {
    const eventId = state.data?.eventId;
    if (!state.notice || !eventId || notifiedEventId.current === eventId) return;
    notifiedEventId.current = eventId;
    onSentRef.current?.();
  }, [state]);

  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="source_id" value={sourceId} />
        <input type="hidden" name="payload" value={payloadStr} />
        <Button type="submit" disabled={pending} className="gap-2">
          <Play className="size-4" />
          {pending ? "Sending via ingest…" : "Send test event"}
        </Button>

        {state.error ? (
          <Alert variant="destructive">
            <AlertDescription>{state.error}</AlertDescription>
          </Alert>
        ) : null}
        {state.notice ? (
          <Alert>
            <CheckCircle className="size-4" />
            <AlertDescription className="font-mono text-xs">{state.notice}</AlertDescription>
          </Alert>
        ) : null}
      </form>

      {inspector.phase !== "idle" ? <Inspector sourceId={sourceId} inspector={inspector} /> : null}
    </div>
  );
}

/**
 * Renders the REAL routing/delivery outcome of a sent test event: which
 * routes matched and what each destination returned. Shared by the wizard
 * activation step and SendTestEventDialog.
 */
export function Inspector({
  sourceId,
  inspector,
}: {
  sourceId: string;
  inspector: Exclude<InspectorState, { phase: "idle" }>;
}) {
  const eventId = inspector.eventId;
  const isPolling = inspector.phase === "polling";
  const outcome = inspector.phase === "error" ? null : inspector.outcome;

  return (
    <div className="rounded-md border bg-muted/30 p-4 space-y-3" role="status" aria-live="polite">
      <div className="font-medium text-sm flex items-center gap-2">
        Inspector results
        {isPolling && (
          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> polling…
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4 text-xs font-mono">
        <div className="col-span-2">
          <div className="text-muted-foreground">Event ID</div>
          <a
            href={`/sources/${sourceId}/events/${eventId}`}
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            {eventId}
          </a>
        </div>

        {inspector.phase === "error" ? (
          (() => {
            // ClickHouse-off is an expected local/degraded state, not a real
            // failure — the send still succeeded. Show informational copy +
            // a path to event history rather than a red error.
            const chOff = inspector.message.includes("ClickHouse is not configured");
            return (
              <div className={`col-span-2 space-y-1 ${chOff ? "text-muted-foreground" : "text-destructive"}`}>
                <div className="flex items-center gap-1">
                  {chOff ? <AlertCircle className="size-3.5" /> : <XCircle className="size-3.5" />}
                  {chOff
                    ? "Test event sent — live routing results need ClickHouse, which isn't configured here. Check event history to confirm it routed."
                    : `Couldn't read result: ${inspector.message}`}
                </div>
                {chOff ? (
                  <a
                    href={`/sources/${sourceId}#recent-events`}
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open event history
                  </a>
                ) : null}
              </div>
            );
          })()
        ) : (
          <>
            <div className="col-span-2">
              <div className="text-muted-foreground">Matched routes</div>
              {outcome && outcome.matched_routes.length > 0 ? (
                <ul className="list-disc pl-4">
                  {outcome.matched_routes.map((r) => (
                    <li key={r.route_id}>{r.label}</li>
                  ))}
                </ul>
              ) : isPolling ? (
                <div className="text-muted-foreground">Evaluating routes…</div>
              ) : (
                <div className="flex items-center gap-1 text-amber-600">
                  <AlertCircle className="size-3.5" />
                  No routes matched this event — nothing will be delivered. Check the
                  source's routes before going live.
                </div>
              )}
            </div>

            <div className="col-span-2">
              <div className="text-muted-foreground">Destination attempts</div>
              {outcome && outcome.delivery_attempts.length > 0 ? (
                outcome.delivery_attempts.map((a) => {
                  const ok = a.status === "success";
                  return (
                    <div key={`${a.route_id}:${a.destination_id}`} className="border-l-2 pl-2 my-1">
                      <span className={ok ? "text-green-600" : "text-destructive"}>
                        {ok ? "✓" : "✗"}
                      </span>{" "}
                      {a.destination_name ?? a.destination_id}: {a.status}
                      {a.http_status !== null ? ` — HTTP ${a.http_status}` : ""}
                      {` (${a.latency_ms}ms)`}
                      {a.error ? <span className="text-destructive"> — {a.error}</span> : null}
                    </div>
                  );
                })
              ) : outcome && !outcome.any_matched && !isPolling ? (
                <div className="text-muted-foreground">No delivery — no route matched.</div>
              ) : isPolling || (outcome && outcome.any_matched && !outcome.any_delivered) ? (
                <div className="flex items-center gap-1 text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Awaiting delivery…
                </div>
              ) : (
                <div className="text-muted-foreground">Awaiting delivery…</div>
              )}
            </div>
          </>
        )}
      </div>

      <p className="text-[10px] text-muted-foreground">
        Test event visible in history (marked synthetic, excluded from usage metrics).
      </p>
    </div>
  );
}
