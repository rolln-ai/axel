"use client";

import { useActionState, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { refreshDataContractNow, type ActionState } from "../../../../lib/data-contracts/refresh";
import {
  dataContractRefreshRegistry,
  deriveRefreshPhase,
} from "../../../../lib/data-contracts/refresh-ui";

/**
 * "Refresh now" companion to the auto-extend cron. Calls
 * refreshDataContractNow which re-samples + re-infers + appends a new
 * version if any new event types showed up. Works on draft maps too
 * (the cron skips drafts).
 *
 * After a successful extension we router.refresh() so the new
 * clusters appear on the page without a manual reload.
 *
 * Shares dataContractRefreshRegistry with DataContractAutoRefresh: while the
 * auto-refresh (or any other trigger) has a refresh in flight for this
 * contract, the button is disabled and — belt and braces — the submit handler
 * refuses to dispatch a second concurrent action.
 */
export function RefreshDataContractButton({ dataContractId }: { dataContractId: string }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(refreshDataContractNow, {});
  const ownsFlightRef = useRef(false);
  const phase = deriveRefreshPhase(state, pending);

  // True while ANY trigger (this button, the auto-refresh) has a refresh in
  // flight for this contract. Server snapshot is false — nothing can be in
  // flight in SSR HTML.
  const inFlight = useSyncExternalStore(
    dataContractRefreshRegistry.subscribe,
    () => dataContractRefreshRegistry.isInFlight(dataContractId),
    () => false,
  );

  // Release the shared guard when our action settles or we unmount mid-flight.
  useEffect(() => {
    if (pending) return;
    if (ownsFlightRef.current) {
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

  useEffect(() => {
    if (state.data?.new_version_id) {
      router.refresh();
    }
  }, [state.data?.new_version_id, router]);

  const busy = pending || inFlight;

  return (
    <div className="space-y-2">
      <form
        action={(fd: FormData) => {
          if (!dataContractRefreshRegistry.begin(dataContractId)) return;
          ownsFlightRef.current = true;
          action(fd);
        }}
      >
        <input type="hidden" name="data_contract_id" value={dataContractId} />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={busy}
          className="gap-1.5"
        >
          <RefreshCw className={`size-3.5 ${busy ? "animate-spin" : ""}`} />
          {busy ? "Sampling…" : "Refresh now"}
        </Button>
      </form>
      {phase === "error" && state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : phase === "success" && state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
