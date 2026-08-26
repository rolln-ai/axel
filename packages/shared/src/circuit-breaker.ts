/**
 * AXE-27/28 — per-destination circuit breaker: the shared, PURE decision core.
 *
 * Two runtimes gate deliveries on the same `destinations` columns
 * (`circuit_state`, `circuit_opened_at`, `circuit_half_open_at`,
 * `circuit_cooldown_seconds`, `delivery_paused`, `retry_after_until`):
 * delivery-service (node-pg) and delivery-edge (postgres.js). They used to
 * carry independent forks of the state machine — the edge fork could OPEN a
 * breaker but never ran the open→half_open flip or the half_open probe
 * timeout, so an edge-only destination could get stuck. `evaluateBreaker`
 * is now the single decision function; each app keeps only its SQL dialect
 * for the atomic conditional transitions the evaluation asks for.
 *
 * Decision order (canonical — matches the delivery-service implementation):
 *   disabled → paused → retry-after window → open → half_open → deliver.
 *
 * Reason strings are canonical too; the edge previously said
 * "circuit_disabled" where delivery-service said
 * "destination_disabled_manually" — the delivery-service strings win.
 */

import type { DeliveryAttempt } from "./types.js";

/**
 * Worker-facing decision. (Moved verbatim from apps/delivery-worker, which
 * re-exports it for compatibility.)
 */
export type CircuitDecision =
  /** Open the connector — deliver normally. */
  | { decision: "deliver" }
  /** Cooldown still active — skip this attempt, treat as retry.
   *  `retry_after_ms` is how long delivery is expected to stay blocked;
   *  the worker uses it as a floor on the retry delay so a known-blocked
   *  window doesn't burn the cheap early backoff steps. */
  | { decision: "skip_retry"; reason: string; retry_after_ms?: number }
  /** Manually disabled — skip and dead-letter so the queue drains. */
  | { decision: "skip_dead"; reason: string };

/**
 * The breaker surface the delivery worker calls around each attempt.
 * Implementations live outside the worker (Postgres-backed in
 * delivery-service / delivery-edge; in-memory for tests).
 */
export interface CircuitBreaker {
  acquire(input: { workspaceId: string; destinationId: string }): Promise<CircuitDecision>;
  recordOutcome(input: {
    workspaceId: string;
    destinationId: string;
    status: DeliveryAttempt["status"];
    /** AXE-28 — full attempt so the breaker can read response body
     *  for 429/Retry-After hints. Optional for backwards compat. */
    attempt?: DeliveryAttempt;
  }): Promise<void> | void;
}

/** A decision that skips the attempt (never "deliver"). */
export type CircuitSkipDecision = Exclude<CircuitDecision, { decision: "deliver" }>;

export type CircuitState = "closed" | "open" | "half_open" | "disabled";

/** The `destinations` breaker columns as loaded by either runtime. */
export interface BreakerRow {
  circuit_state: CircuitState | null;
  /** ISO / `timestamptz::text` timestamps (both parse with Date.parse). */
  circuit_opened_at: string | null;
  circuit_half_open_at: string | null;
  circuit_cooldown_seconds: number | null;
  delivery_paused: boolean | null;
  retry_after_until: string | null;
}

export const BREAKER_DEFAULT_COOLDOWN_SECONDS = 60;
/** Operator pause is indefinite — hold each retry cycle 5 minutes. */
export const BREAKER_PAUSE_RETRY_MS = 5 * 60_000;

/**
 * The pure evaluation can't perform the atomic compare-and-set transitions
 * itself, so when one is required it returns the transition intent plus the
 * decision for each side of the race. The caller runs its runtime's
 * conditional UPDATE and picks the decision by whether any row changed.
 */
export type BreakerEvaluation =
  /** No state transition needed — use `decision` as-is. */
  | { action: "decide"; decision: CircuitDecision }
  /**
   * Open breaker whose cooldown has expired: atomically flip
   * open→half_open (`circuit_half_open_at = now()`, failure counter reset
   * to 0, conditional on `circuit_state = 'open'`). If the UPDATE changed a
   * row this attempt is the probe (`won`, i.e. deliver — the probe takes
   * precedence over any rate-limit cap so the breaker can recover);
   * otherwise another worker beat us to it (`lost`).
   */
  | { action: "attempt_half_open_probe"; won: CircuitDecision; lost: CircuitSkipDecision }
  /**
   * half_open probe that never resolved (worker crash, hung connector):
   * atomically flip half_open→open (`circuit_opened_at = now()`, conditional
   * on state still being 'half_open' with an unchanged
   * `circuit_half_open_at`) so the cooldown timer runs again and a fresh
   * probe is eventually promoted. `decision` applies whether or not the
   * UPDATE won the race; a winning caller should audit the transition
   * (cause: half_open_probe_timed_out) with `elapsed_ms`.
   */
  | { action: "reopen_timed_out_probe"; decision: CircuitSkipDecision; elapsed_ms: number | null };

/**
 * Evaluate the breaker/delivery-control state for one destination row.
 * Pure — `now` is epoch milliseconds. Rate limiting (delivery-service's
 * token bucket) is applied by the caller AFTER a "deliver" decision from a
 * `decide` action; an `attempt_half_open_probe` won-probe bypasses it.
 */
export function evaluateBreaker(row: BreakerRow, now: number): BreakerEvaluation {
  const cooldownMs =
    (row.circuit_cooldown_seconds ?? BREAKER_DEFAULT_COOLDOWN_SECONDS) * 1000;

  if (row.circuit_state === "disabled") {
    return decide({ decision: "skip_dead", reason: "destination_disabled_manually" });
  }
  if (row.delivery_paused) {
    return decide({
      decision: "skip_retry",
      reason: "delivery_paused",
      retry_after_ms: BREAKER_PAUSE_RETRY_MS,
    });
  }
  if (row.retry_after_until) {
    const until = Date.parse(row.retry_after_until);
    if (until > now) {
      return decide({
        decision: "skip_retry",
        reason: "retry_after_window_active",
        retry_after_ms: until - now,
      });
    }
  }
  if (row.circuit_state === "open") {
    const openedAt = row.circuit_opened_at ? Date.parse(row.circuit_opened_at) : 0;
    const elapsed = now - openedAt;
    if (elapsed >= cooldownMs) {
      return {
        action: "attempt_half_open_probe",
        won: { decision: "deliver" },
        lost: {
          decision: "skip_retry",
          reason: "half_open_probe_in_flight",
          retry_after_ms: cooldownMs,
        },
      };
    }
    return decide({
      decision: "skip_retry",
      reason: "breaker_open_cooldown_active",
      retry_after_ms: Math.max(cooldownMs - elapsed, 1000),
    });
  }
  if (row.circuit_state === "half_open") {
    const halfOpenAt = row.circuit_half_open_at
      ? Date.parse(row.circuit_half_open_at)
      : null;
    const halfOpenElapsed = halfOpenAt === null ? Infinity : now - halfOpenAt;
    if (halfOpenAt === null || halfOpenElapsed >= cooldownMs) {
      return {
        action: "reopen_timed_out_probe",
        decision: {
          decision: "skip_retry",
          reason: "half_open_probe_timed_out",
          retry_after_ms: cooldownMs,
        },
        elapsed_ms: halfOpenAt === null ? null : halfOpenElapsed,
      };
    }
    return decide({
      decision: "skip_retry",
      reason: "half_open_probe_in_flight",
      retry_after_ms: cooldownMs,
    });
  }
  // closed (or unknown/null state) — deliver.
  return decide({ decision: "deliver" });
}

function decide(decision: CircuitDecision): BreakerEvaluation {
  return { action: "decide", decision };
}
