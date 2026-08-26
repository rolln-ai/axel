"use client";

import { useActionState, useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { RotateCw, Check } from "lucide-react";
import { requestInvestigationReplayAll } from "../../../../../lib/replay-actions";
import type { ActionState } from "../../../../../lib/action-data";
import { Button } from "@/components/ui/button";

/**
 * Bulk-replays every unresolved dead-letter in the (source, reason) group
 * the operator is investigating. One server-action round-trip; the action
 * invalidates the dashboard's replay + dead-letter caches, so the next
 * render of /investigate shows the lowered unresolved count (and flips to
 * the "Resolved" banner once all replays finish).
 */
export function InvestigationReplayAllButton({
  deadLetterId,
  unresolvedCount,
}: {
  deadLetterId: string;
  unresolvedCount: number;
}) {
  const router = useRouter();
  const [state, action] = useActionState<ActionState, FormData>(
    requestInvestigationReplayAll,
    {},
  );

  useEffect(() => {
    if (state.notice) router.refresh();
  }, [state.notice, router]);

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="dead_letter_id" value={deadLetterId} />
      <input type="hidden" name="reason" value="investigation_replay_all" />
      <SubmitButton count={unresolvedCount} done={Boolean(state.notice)} />
      {state.error ? (
        <span role="alert" className="text-[10px] text-destructive">{state.error}</span>
      ) : state.notice ? (
        <span aria-live="polite" className="text-[10px] text-muted-foreground">{state.notice}</span>
      ) : null}
    </form>
  );
}

function SubmitButton({ count, done }: { count: number; done: boolean }) {
  const { pending } = useFormStatus();
  const label = pending
    ? "Queuing…"
    : done
      ? "Queued"
      : count === 1
        ? "Replay 1 unresolved"
        : `Replay all ${count.toLocaleString("en-US")} unresolved`;
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
        <RotateCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
      )}
      {label}
    </Button>
  );
}
