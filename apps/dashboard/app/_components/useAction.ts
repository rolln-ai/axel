"use client";

import * as React from "react";
import type { ActionState } from "../../lib/action-state";

/** The outcome envelope convention — `ActionState` (lib/action-state.ts). */
type ActionOutcome = Pick<ActionState<unknown>, "error" | "notice">;

function outcomeOf(result: object | null): ActionOutcome {
  return (result ?? {}) as ActionOutcome;
}

export interface UseActionReturn<TArgs extends unknown[], TResult extends object> {
  /** Invoke the action inside a transition. Safe to call from event handlers. */
  run: (...args: TArgs) => void;
  pending: boolean;
  error?: string | undefined;
  notice?: string | undefined;
  /** Full result of the most recent completed run, for data-bearing actions. */
  result: TResult | null;
  /** Clear the last outcome (also happens automatically on the next `run`). */
  reset: () => void;
}

/**
 * Counterpart to `useActionState` for server actions called with typed args
 * from client state (no FormData). Runs the action in a transition and keeps
 * the last result, normalized to the `ActionState` shape (`{ error?, notice? }`
 * plus any action-specific payload), so every action button surfaces
 * `pending` / `error` / `notice` the same way.
 *
 * Convention: FormData-driven forms keep `useActionState`; direct calls use
 * this hook. Pair with `useActionStateToast` for transient outcomes.
 *
 * Thrown errors are not swallowed — wrap the action in its own try/catch if
 * a site needs to normalize network failures into `{ error }` copy.
 */
export function useAction<TArgs extends unknown[], TResult extends object>(
  fn: (...args: TArgs) => Promise<TResult>,
  opts: { onSuccess?: (result: TResult) => void } = {},
): UseActionReturn<TArgs, TResult> {
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<TResult | null>(null);
  // Refs so `run` stays stable while always seeing the latest fn/callbacks.
  const fnRef = React.useRef(fn);
  fnRef.current = fn;
  const optsRef = React.useRef(opts);
  optsRef.current = opts;

  const run = React.useCallback((...args: TArgs) => {
    setResult(null);
    startTransition(async () => {
      const next = await fnRef.current(...args);
      setResult(next);
      if (!outcomeOf(next).error) optsRef.current.onSuccess?.(next);
    });
  }, []);

  const reset = React.useCallback(() => setResult(null), []);

  return {
    run,
    pending,
    error: outcomeOf(result).error,
    notice: outcomeOf(result).notice,
    result,
    reset,
  };
}
