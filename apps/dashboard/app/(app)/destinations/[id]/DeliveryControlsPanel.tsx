"use client";

import { useActionState } from "react";
import { destinationDeliveryControlsAction } from "../../../../lib/destination-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * AXE-28 — destination delivery-controls panel: rate limit (RPS),
 * per-attempt timeout, manual pause/resume. Renders alongside the
 * AXE-27 circuit-breaker panel; the two surface different failure
 * modes (operator-initiated soft hold vs. health-protected hard
 * trip).
 */
export function DeliveryControlsPanel({
  destinationId,
  paused,
  pausedReason,
  rateLimitRps,
  requestTimeoutMs,
  retryAfterUntil,
  canMutate,
}: {
  destinationId: string;
  paused: boolean;
  pausedReason: string | null;
  rateLimitRps: number | null;
  requestTimeoutMs: number | null;
  retryAfterUntil: string | null;
  canMutate: boolean;
}) {
  const [pauseState, pauseAction, pausePending] = useActionState<ActionState, FormData>(
    destinationDeliveryControlsAction,
    {},
  );
  const [resumeState, resumeAction, resumePending] = useActionState<ActionState, FormData>(
    destinationDeliveryControlsAction,
    {},
  );
  const [updateState, updateAction, updatePending] = useActionState<ActionState, FormData>(
    destinationDeliveryControlsAction,
    {},
  );
  const pending = pausePending || resumePending || updatePending;

  const retryAfterRemainingMs =
    retryAfterUntil && Date.parse(retryAfterUntil) > Date.now()
      ? Date.parse(retryAfterUntil) - Date.now()
      : 0;

  return (
    <section
      className="mb-6 rounded-lg border border-border bg-card p-4"
      aria-label="Delivery controls"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">Delivery controls</h3>
          <p className="text-xs text-muted-foreground">
            Rate limit, request timeout, and operator pause. Pausing keeps events queued
            and retries them when resumed.
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
            paused
              ? "bg-yellow-500/15 text-yellow-700 dark:text-yellow-400"
              : "bg-green-500/15 text-green-600 dark:text-green-400"
          }`}
        >
          {paused ? "paused" : "delivering"}
        </span>
      </div>

      {retryAfterRemainingMs > 0 ? (
        <Alert className="mt-3">
          <AlertDescription>
            Honoring destination's <code>Retry-After</code> for{" "}
            <strong>~{Math.ceil(retryAfterRemainingMs / 1000)}s</strong>. Delivery resumes
            automatically.
          </AlertDescription>
        </Alert>
      ) : null}

      {paused && pausedReason ? (
        <Alert className="mt-3">
          <AlertDescription>
            <strong>Pause reason:</strong> {pausedReason}
          </AlertDescription>
        </Alert>
      ) : null}

      {[pauseState.error, resumeState.error, updateState.error]
        .filter((e): e is string => Boolean(e))
        .map((err) => (
          <Alert key={err} variant="destructive" className="mt-3">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        ))}
      {[pauseState.notice, resumeState.notice, updateState.notice]
        .filter((n): n is string => Boolean(n))
        .map((notice) => (
          <Alert key={notice} className="mt-3">
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ))}

      <form action={updateAction} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <input type="hidden" name="destination_id" value={destinationId} />
        <input type="hidden" name="action" value="update_controls" />
        <div className="space-y-1.5">
          <Label htmlFor="rate-limit-rps">Rate limit (RPS)</Label>
          <Input
            id="rate-limit-rps"
            name="rate_limit_rps"
            type="number"
            min={1}
            max={100_000}
            placeholder="unlimited"
            defaultValue={rateLimitRps ?? ""}
            disabled={!canMutate}
          />
          <p className="text-[11px] text-muted-foreground">
            Token-bucket cap. Empty = unlimited. Concurrent workers share the bucket.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="request-timeout-ms">Request timeout (ms)</Label>
          <Input
            id="request-timeout-ms"
            name="request_timeout_ms"
            type="number"
            min={100}
            max={300_000}
            placeholder="connector default"
            defaultValue={requestTimeoutMs ?? ""}
            disabled={!canMutate}
          />
          <p className="text-[11px] text-muted-foreground">
            100ms – 300000ms. Empty = use the connector's default (typically 10s).
          </p>
        </div>
        {canMutate ? (
          <div className="sm:col-span-2 flex justify-end">
            <Button type="submit" size="sm" variant="outline" disabled={pending}>
              Save controls
            </Button>
          </div>
        ) : null}
      </form>

      {canMutate ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          {paused ? (
            <form action={resumeAction}>
              <input type="hidden" name="destination_id" value={destinationId} />
              <input type="hidden" name="action" value="resume" />
              <Button type="submit" size="sm" disabled={pending}>
                Resume delivery
              </Button>
            </form>
          ) : (
            <form action={pauseAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="destination_id" value={destinationId} />
              <input type="hidden" name="action" value="pause" />
              {/* Visually the placeholder carries the hint, but the field needs a
                  real <Label htmlFor> (like the RPS/timeout inputs above) so its
                  accessible name survives once the placeholder is typed over. */}
              <Label htmlFor="pause-reason" className="sr-only">
                Pause reason (optional)
              </Label>
              <Input
                id="pause-reason"
                name="reason"
                placeholder="optional pause reason"
                className="h-8 w-64"
                spellCheck={false}
              />
              <Button type="submit" size="sm" variant="secondary" disabled={pending}>
                Pause delivery
              </Button>
            </form>
          )}
        </div>
      ) : null}
    </section>
  );
}
