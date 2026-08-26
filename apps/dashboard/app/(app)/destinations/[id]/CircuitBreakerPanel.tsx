"use client";

import { useActionState } from "react";
import { destinationCircuitAction } from "../../../../lib/destination-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "../../../_components/ConfirmAction";

/**
 * AXE-27 — destination circuit breaker control panel.
 *
 * Renders the current state + summary of how it got there, plus the
 * three operator actions (reset / disable / enable). Hidden when the
 * breaker is closed and the destination is not disabled, since there's
 * nothing actionable to show — same pattern as the existing
 * RotateCredentialForm.
 */
export function CircuitBreakerPanel({
  destinationId,
  state,
  openedAt,
  consecutiveFailures,
  thresholdFailures,
  cooldownSeconds,
  canMutate,
}: {
  destinationId: string;
  state: "closed" | "open" | "half_open" | "disabled";
  openedAt: string | null;
  consecutiveFailures: number;
  thresholdFailures: number;
  cooldownSeconds: number;
  canMutate: boolean;
}) {
  const [resetState, resetAction, resetPending] = useActionState<ActionState, FormData>(
    destinationCircuitAction,
    {},
  );
  const [disableState, disableAction, disablePending] = useActionState<ActionState, FormData>(
    destinationCircuitAction,
    {},
  );
  const [enableState, enableAction, enablePending] = useActionState<ActionState, FormData>(
    destinationCircuitAction,
    {},
  );
  const pending = resetPending || disablePending || enablePending;

  const cooldownRemainingMs = state === "open" && openedAt
    ? Math.max(0, cooldownSeconds * 1000 - (Date.now() - Date.parse(openedAt)))
    : 0;
  const cooldownLabel =
    cooldownRemainingMs > 0
      ? `~${Math.ceil(cooldownRemainingMs / 1000)}s until probe`
      : "cooldown elapsed";

  return (
    <section
      className="mb-6 rounded-lg border border-border bg-card p-4"
      aria-label="Circuit breaker"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Circuit breaker</h3>
          <p className="text-xs text-muted-foreground">
            {state === "closed" ? (
              <>Healthy. Deliveries pass through normally.</>
            ) : state === "open" ? (
              <>
                <span className="font-medium text-foreground">Open</span> — deliveries are
                paused after {consecutiveFailures} consecutive failures (threshold:{" "}
                {thresholdFailures}). {cooldownLabel}.
              </>
            ) : state === "half_open" ? (
              <>
                <span className="font-medium text-foreground">Half-open</span> — a probe
                attempt is in flight. Success closes the breaker; failure re-opens it.
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">Disabled</span> — deliveries
                are dead-lettered until you re-enable the destination.
              </>
            )}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            state === "closed"
              ? "bg-green-500/15 text-green-600 dark:text-green-400"
              : state === "open"
              ? "bg-amber-500/15 text-amber-600 dark:text-amber-400"
              : state === "half_open"
              ? "bg-blue-500/15 text-blue-600 dark:text-blue-400"
              : "bg-red-500/15 text-red-600 dark:text-red-400"
          }`}
        >
          {state}
        </span>
      </div>

      {[resetState.error, disableState.error, enableState.error]
        .filter((e): e is string => Boolean(e))
        .map((err) => (
          <Alert key={err} variant="destructive" className="mt-3">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        ))}
      {[resetState.notice, disableState.notice, enableState.notice]
        .filter((n): n is string => Boolean(n))
        .map((notice) => (
          <Alert key={notice} className="mt-3">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ))}

      {canMutate ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {state === "disabled" ? (
            <form action={enableAction}>
              <input type="hidden" name="destination_id" value={destinationId} />
              <input type="hidden" name="action" value="enable" />
              <Button type="submit" size="sm" disabled={pending}>
                Re-enable destination
              </Button>
            </form>
          ) : (
            <>
              <form action={resetAction}>
                <input type="hidden" name="destination_id" value={destinationId} />
                <input type="hidden" name="action" value="reset" />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={pending || state === "closed"}
                  title={state === "closed" ? "Nothing to reset" : "Force-close the breaker"}
                >
                  Reset breaker
                </Button>
              </form>
              <form action={disableAction}>
                <input type="hidden" name="destination_id" value={destinationId} />
                <input type="hidden" name="action" value="disable" />
                <ConfirmAction
                  title="Disable destination"
                  body="Disable this destination? All deliveries will hard-drop to the dead-letter queue until re-enabled."
                  confirmLabel="Disable"
                  destructive
                >
                  <Button type="button" size="sm" variant="destructive" disabled={pending}>
                    Disable destination
                  </Button>
                </ConfirmAction>
              </form>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
