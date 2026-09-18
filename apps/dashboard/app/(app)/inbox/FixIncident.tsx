"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  fixIncidentAction,
  recheckIncidentAction,
  type FixIncidentResult,
} from "../../../lib/incident-fix-actions";

/** Keep polling this long after a fix before handing off to the 15-minute cron. */
const POLL_WINDOW_MS = 5 * 60_000;
const POLL_EVERY_MS = 5_000;

type Phase =
  | { kind: "idle" }
  | { kind: "queued"; notice: string }
  | { kind: "replaying"; inFlight: number; remaining: number }
  | { kind: "confirming" }
  | { kind: "fixed" }
  | { kind: "handed_off"; remaining: number }
  | { kind: "error"; error: string };

/**
 * The one button on an incident card. Click: Axel repairs what it can,
 * replays the retained events, then polls until the monitor closes the
 * alert. The card disappears on the refresh that observes the close.
 */
export function FixIncident({
  incidentId,
  fixRequestedAt,
}: {
  incidentId: string;
  /** Set when a fix is already in progress (page reloaded mid-fix). */
  fixRequestedAt: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const resumed = fixRequestedAt !== null && Date.now() - Date.parse(fixRequestedAt) < POLL_WINDOW_MS;
  const [phase, setPhase] = useState<Phase>(resumed ? { kind: "confirming" } : { kind: "idle" });
  const [polling, setPolling] = useState(resumed);
  const pollStarted = useRef<number>(Date.now());

  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    async function tick() {
      const result = await recheckIncidentAction({ incidentId });
      if (cancelled) return;
      if (result.error) {
        setPhase({ kind: "error", error: result.error });
        setPolling(false);
        return;
      }
      if (result.resolved) {
        setPhase({ kind: "fixed" });
        setPolling(false);
        router.refresh();
        return;
      }
      if (result.inFlight > 0) setPhase({ kind: "replaying", inFlight: result.inFlight, remaining: result.remaining });
      else setPhase({ kind: "confirming" });
      if (Date.now() - pollStarted.current > POLL_WINDOW_MS) {
        setPhase({ kind: "handed_off", remaining: result.remaining });
        setPolling(false);
      }
    }
    void tick();
    const handle = window.setInterval(() => void tick(), POLL_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [polling, incidentId, router]);

  function onFix() {
    start(async () => {
      const result: FixIncidentResult = await fixIncidentAction({ incidentId });
      if (!result.ok) {
        setPhase({ kind: "error", error: result.error ?? "Could not start the fix." });
        return;
      }
      setPhase({ kind: "queued", notice: result.notice ?? "Fix started." });
      pollStarted.current = Date.now();
      setPolling(true);
      router.refresh();
    });
  }

  const busy = pending || polling;
  return (
    <div className="flex flex-col items-end gap-1.5">
      <Button size="sm" onClick={onFix} disabled={busy} aria-live="polite">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : phase.kind === "fixed" ? <CheckCircle2 className="size-3.5" /> : <Wrench className="size-3.5" />}
        {pending ? "Starting…" : polling ? "Fixing…" : phase.kind === "fixed" ? "Fixed" : phase.kind === "handed_off" || phase.kind === "error" ? "Fix again" : "Fix now"}
      </Button>
      <p className="max-w-xs text-right text-xs text-muted-foreground" role="status">
        <PhaseText phase={phase} />
      </p>
    </div>
  );
}

function PhaseText({ phase }: { phase: Phase }) {
  switch (phase.kind) {
    case "idle":
      return null;
    case "queued":
      return <>{phase.notice}</>;
    case "replaying":
      return <>Replaying: {phase.inFlight.toLocaleString("en-US")} in flight, {phase.remaining.toLocaleString("en-US")} still failed.</>;
    case "confirming":
      return <>Replays landed. Confirming with the monitor…</>;
    case "fixed":
      return <>Fixed. This alert is closing.</>;
    case "handed_off":
      return phase.remaining > 0
        ? <>{phase.remaining.toLocaleString("en-US")} events still fail after replay. Open Details to see why.</>
        : <>Replays landed. The monitor confirms and clears this alert within about 15 minutes.</>;
    case "error":
      return <span className="text-destructive">{phase.error}</span>;
  }
}
