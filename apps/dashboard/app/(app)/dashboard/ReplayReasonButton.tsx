"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { RotateCw, Check } from "lucide-react";
import { requestReplayAllUnresolved } from "../../../lib/replay-actions";
import type { ActionState } from "../../../lib/action-data";
import { Button } from "@/components/ui/button";

/**
 * One-click "Replay all N matching this reason" button rendered in
 * the dashboard Activity card. The button wraps a server-action
 * <form> so the click round-trips through requestReplayAllUnresolved
 * with a reason_filter and gets us a toast-style notice / error
 * inline. On success the dashboard's cached repositories are
 * invalidated by the action itself, so the next render shows the
 * lowered count.
 */
export function ReplayReasonButton({
  reason,
  count,
  activeReplayCount = 0,
}: {
  reason: string;
  count: number;
  activeReplayCount?: number;
}) {
  const [state, action] = useActionState<ActionState, FormData>(
    requestReplayAllUnresolved,
    {},
  );

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="reason_filter" value={reason} />
      <input type="hidden" name="reason" value={`replay_all_${reason}`} />
      <SubmitButton
        count={count}
        done={Boolean(state.notice)}
        activeReplayCount={activeReplayCount}
      />
      {state.error ? (
        <span className="text-[10px] text-destructive">{state.error}</span>
      ) : state.notice ? (
        <span className="text-[10px] text-muted-foreground">{state.notice}</span>
      ) : null}
    </form>
  );
}

function SubmitButton({
  count,
  done,
  activeReplayCount,
}: {
  count: number;
  done: boolean;
  activeReplayCount: number;
}) {
  const { pending } = useFormStatus();
  const label = pending
    ? "Queuing…"
    : activeReplayCount > 0
      ? `${activeReplayCount.toLocaleString("en-US")} queued`
      : done
      ? "Queued"
      : `Replay all ${count.toLocaleString("en-US")}`;
  return (
    <Button
      type="submit"
      size="sm"
      variant="default"
      disabled={pending || done || activeReplayCount > 0}
      className="gap-1"
    >
      {done || activeReplayCount > 0 ? (
        <Check className="size-3.5" />
      ) : (
        <RotateCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
      )}
      {label}
    </Button>
  );
}
