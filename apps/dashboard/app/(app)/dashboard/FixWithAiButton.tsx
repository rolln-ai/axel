"use client";

import Link from "next/link";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { Sparkles, Check } from "lucide-react";
import {
  quickFixWithAiAction,
  type QuickFixState,
} from "../../../lib/data-contracts/actions";
import { Button } from "@/components/ui/button";

/**
 * One-click "Fix with AI" button used by the dashboard Activity card
 * for reasons whose root cause is a route DSL bug — the granular
 * transform_* / filter_* RouteEngineError sub-reasons plus the
 * fallback declarative_engine_error. Wraps quickFixWithAiAction so
 * the whole flow — explainFailure, approve patch, drain replays —
 * runs server-side and the operator sees a single inline notice on
 * success.
 *
 * If the AI can't propose a confident patch, or the fixture gate
 * refuses, the action surfaces a fallback_href the user can click to
 * fall back to the manual investigate flow.
 */
export function FixWithAiButton({
  reason,
  count,
}: {
  reason: string;
  count: number;
}) {
  const [state, action] = useActionState<QuickFixState, FormData>(
    quickFixWithAiAction,
    {},
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="reason" value={reason} />
      <SubmitButton count={count} done={Boolean(state.notice)} />
      {state.error ? (
        <div className="flex max-w-[16rem] flex-col items-end gap-0.5">
          <span className="text-right text-[10px] text-destructive">
            {state.error}
          </span>
          {state.fallback_href ? (
            <Link
              href={state.fallback_href}
              className="text-[10px] text-muted-foreground underline hover:text-foreground"
            >
              Open manual review →
            </Link>
          ) : null}
        </div>
      ) : state.notice ? (
        <span className="max-w-[16rem] text-right text-[10px] text-muted-foreground">
          {state.notice}
        </span>
      ) : (
        <span className="max-w-[18rem] text-right text-[10px] text-muted-foreground">
          AI sees field paths, type markers, and DSL shape, never event values. An approved fix
          replays the {count.toLocaleString("en-US")} failed event{count === 1 ? "" : "s"}.
        </span>
      )}
    </form>
  );
}

function SubmitButton({ count, done }: { count: number; done: boolean }) {
  const { pending } = useFormStatus();
  const label = pending
    ? "Fixing…"
    : done
      ? "Fixed"
      : `Fix with AI (${count.toLocaleString("en-US")})`;
  return (
    <Button
      type="submit"
      size="sm"
      variant="default"
      disabled={pending || done}
      className="gap-1"
    >
      {done ? (
        <Check className="size-3.5" />
      ) : (
        <Sparkles
          className={pending ? "size-3.5 animate-pulse" : "size-3.5"}
        />
      )}
      {label}
    </Button>
  );
}
