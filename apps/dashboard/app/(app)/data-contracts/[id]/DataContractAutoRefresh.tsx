"use client";

import { useActionState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { refreshDataContractNow, type ActionState } from "../../../../lib/data-contracts/refresh";
import {
  dataContractRefreshRegistry,
  deriveRefreshPhase,
} from "../../../../lib/data-contracts/refresh-ui";

/**
 * Auto re-infers a stale DRAFT Data Contract on view.
 *
 * Rendered by the detail page only when the stored schema was inferred from
 * a tiny sample (the source was near-empty at creation) and a lot of traffic
 * has arrived since. It fires the same `refreshDataContractNow` action as the
 * manual button exactly once on mount, then router.refresh()es when a new
 * version lands so the freshly-discovered event types appear without a manual
 * reload.
 *
 * Why this is safe from looping: the page only renders this component while
 * the snapshot is < 50 samples. A successful re-inference lands ~200 samples
 * (or, for a genuinely small source, resets the "events since version"
 * clock), so the staleness gate closes and the remount after router.refresh()
 * won't re-fire. We also guard with a ref so a single mount fires at most one
 * action.
 *
 * Concurrency: the auto-fire and the manual "Refresh now" button are separate
 * useActionState instances, so they coordinate through the shared
 * dataContractRefreshRegistry — whichever begins first wins, and the other
 * doesn't dispatch. Rendering follows the explicit idle → pending →
 * success | error phase from deriveRefreshPhase, so the pre-fire (and
 * pre-hydration SSR) render never claims the refresh already completed.
 */
export function DataContractAutoRefresh({
  dataContractId,
  sampledCount,
  eventsSinceVersion,
}: {
  dataContractId: string;
  sampledCount: number;
  eventsSinceVersion: number;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(
    refreshDataContractNow,
    {},
  );
  const firedRef = useRef(false);
  const ownsFlightRef = useRef(false);
  const phase = deriveRefreshPhase(state, pending);

  // Fire once on mount — unless another trigger (the manual button, or a
  // previous mount) already has a refresh for this contract in flight.
  useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (!dataContractRefreshRegistry.begin(dataContractId)) return;
    ownsFlightRef.current = true;
    const fd = new FormData();
    fd.set("data_contract_id", dataContractId);
    action(fd);
  }, [action, dataContractId]);

  // Release the shared in-flight guard when our action settles (pending
  // falling edge) or if we unmount mid-flight (client-side navigation).
  useEffect(() => {
    if (pending) return;
    if (ownsFlightRef.current && firedRef.current) {
      ownsFlightRef.current = false;
      dataContractRefreshRegistry.end(dataContractId);
    }
  }, [pending, dataContractId]);
  useEffect(() => {
    return () => {
      if (ownsFlightRef.current) {
        ownsFlightRef.current = false;
        dataContractRefreshRegistry.end(dataContractId);
      }
    };
  }, [dataContractId]);

  // Reveal new clusters once a new version is appended.
  useEffect(() => {
    if (state.data?.new_version_id) {
      router.refresh();
    }
  }, [state.data?.new_version_id, router]);

  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      {/* role="status" (implicit aria-live=polite) so screen readers hear
          the idle → pending → success transitions of the background
          re-sample; the error path is announced by the Alert (role=alert). */}
      <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
        <RefreshCw className={`size-3.5 ${phase === "pending" ? "animate-spin" : ""}`} aria-hidden />
        {phase === "idle" ? (
          <span>
            This draft was inferred from {sampledCount} event
            {sampledCount === 1 ? "" : "s"}; {eventsSinceVersion.toLocaleString()} more have
            arrived since. A re-sample will run in a moment…
          </span>
        ) : phase === "pending" ? (
          <span>
            This draft was inferred from {sampledCount} event
            {sampledCount === 1 ? "" : "s"}; {eventsSinceVersion.toLocaleString()} more have
            arrived since. Re-sampling now to find the rest…
          </span>
        ) : phase === "success" ? (
          <span>
            Refreshed against current traffic ({eventsSinceVersion.toLocaleString()} new event
            {eventsSinceVersion === 1 ? "" : "s"} since this draft was inferred).
          </span>
        ) : null}
      </div>
      {phase === "error" && state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
