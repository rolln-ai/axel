/**
 * Client-safe helpers for the Data Contract refresh UI
 * (DataContractAutoRefresh + RefreshDataContractButton).
 *
 * Two concerns, both extracted as pure functions so they get node-environment
 * vitest coverage (the repo's established pattern for client logic):
 *
 * 1. `deriveRefreshPhase` — an explicit idle → pending → success | error
 *    state machine over `useActionState`'s (state, pending) pair. The old
 *    rendering branched only on `pending` / `state.error`, so the initial
 *    `{}` state (idle — the action hasn't fired yet, including the raw SSR
 *    HTML before hydration) fell through to the success copy and read as
 *    "Refreshed…" before anything ran.
 *
 * 2. A tiny in-flight registry shared by every refresh trigger on a page.
 *    The auto-refresh (fires on mount) and the manual "Refresh now" button
 *    are separate `useActionState` instances with independent `pending`
 *    flags; without a shared guard they can double-fire the same
 *    `refreshDataContractNow` action concurrently. The registry is a
 *    module-level singleton keyed by data contract id: `begin` is an atomic
 *    check-and-set (single-threaded JS), and `subscribe`/`isInFlight` plug
 *    straight into `useSyncExternalStore`.
 *
 * NOTE: this file is imported by client components — no "server-only".
 */

export type RefreshPhase = "idle" | "pending" | "success" | "error";

export interface RefreshActionStateLike {
  error?: string;
  notice?: string;
  data?: unknown;
}

/**
 * Map `useActionState`'s (state, pending) pair onto an explicit phase.
 *
 * - `pending`   → the action is running right now.
 * - `error` set → the last completed run failed.
 * - `notice`/`data` set → the last completed run succeeded (every success
 *   return of refreshDataContractNow sets at least `notice`).
 * - none of the above → idle: the action has never completed (or fired).
 */
export function deriveRefreshPhase(
  state: RefreshActionStateLike,
  pending: boolean,
): RefreshPhase {
  if (pending) return "pending";
  if (state.error) return "error";
  if (state.notice !== undefined || state.data !== undefined) return "success";
  return "idle";
}

export interface RefreshInFlightRegistry {
  /**
   * Atomically mark `id` as refreshing. Returns false (and does nothing)
   * when a refresh for `id` is already in flight — the caller must NOT
   * dispatch its action in that case.
   */
  begin(id: string): boolean;
  /** Clear the in-flight mark for `id` (no-op when not set). */
  end(id: string): void;
  isInFlight(id: string): boolean;
  /** useSyncExternalStore-compatible: notifies on every begin/end. */
  subscribe(listener: () => void): () => void;
}

/** Factory so tests exercise a fresh registry; the app uses the singleton. */
export function createRefreshInFlightRegistry(): RefreshInFlightRegistry {
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    begin(id) {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      emit();
      return true;
    },
    end(id) {
      if (!inFlight.delete(id)) return;
      emit();
    },
    isInFlight(id) {
      return inFlight.has(id);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * Shared per-runtime singleton. Both refresh triggers on the contract detail
 * page consult this before dispatching, so only one refreshDataContractNow
 * per data contract is ever in flight from a given client.
 */
export const dataContractRefreshRegistry = createRefreshInFlightRegistry();
