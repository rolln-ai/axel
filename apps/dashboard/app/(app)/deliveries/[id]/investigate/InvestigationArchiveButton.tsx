"use client";

import { useActionState, useEffect, type ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { Archive, Check } from "lucide-react";
import { archiveInvestigationFailures } from "../../../../../lib/replay-actions";
import type { ActionState } from "../../../../../lib/action-data";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "../../../../_components/ConfirmAction";

/**
 * Archives (resolves without replaying) every unresolved dead-letter in the
 * (source, reason) group — for benign failures the operator just wants out of
 * the inbox. Sibling to InvestigationReplayAllButton; same one-round-trip
 * server action, which invalidates the dead-letter cache so the inbox count
 * drops on the next render.
 */
export function InvestigationArchiveButton({
  deadLetterId,
  unresolvedCount,
}: {
  deadLetterId: string;
  unresolvedCount: number;
}) {
  const router = useRouter();
  const [state, action] = useActionState<ActionState, FormData>(
    archiveInvestigationFailures,
    {},
  );

  // Refresh the server-rendered investigate page after a successful archive so
  // the (source, reason) counts/labels reflect the now-resolved group instead
  // of staying frozen at the pre-action numbers.
  useEffect(() => {
    if (state.notice) router.refresh();
  }, [state.notice, router]);

  // Bulk, irreversible (no un-archive): confirm with the live count first.
  const n = unresolvedCount.toLocaleString("en-US");

  return (
    <form action={action} className="flex flex-col items-end gap-1">
      <input type="hidden" name="dead_letter_id" value={deadLetterId} />
      <ConfirmAction
        title="Archive failures"
        body={
          `Archive ${n} unresolved failure${unresolvedCount === 1 ? "" : "s"} in this group? ` +
          "This resolves them without replaying and can't be undone."
        }
        confirmLabel="Archive"
        destructive
      >
        <SubmitButton count={unresolvedCount} done={Boolean(state.notice)} />
      </ConfirmAction>
      {state.error ? (
        <span role="alert" className="text-[10px] text-destructive">{state.error}</span>
      ) : state.notice ? (
        <span aria-live="polite" className="text-[10px] text-muted-foreground">{state.notice}</span>
      ) : null}
    </form>
  );
}

// Spreads rest props onto the Button so it can be the ConfirmAction trigger
// (Radix Slot merges its open-dialog handlers into the rendered element).
function SubmitButton({
  count,
  done,
  ...props
}: { count: number; done: boolean } & ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  const label = pending
    ? "Archiving…"
    : done
      ? "Archived"
      : count <= 1
        ? "Archive failure"
        : `Archive all ${count.toLocaleString("en-US")}`;
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending || done}
      className="gap-1"
      {...props}
    >
      {done ? <Check className="size-3.5" /> : <Archive className="size-3.5" />}
      {label}
    </Button>
  );
}
