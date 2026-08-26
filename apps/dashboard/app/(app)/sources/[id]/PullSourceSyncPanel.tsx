"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { triggerPullSourceSync } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export function PullSourceSyncPanel({
  sourceId,
  canSync,
}: {
  sourceId: string;
  canSync: boolean;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(triggerPullSourceSync, {});

  useEffect(() => {
    if (state.notice) router.refresh();
  }, [state.notice, router]);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="source_id" value={sourceId} />
      {state.error ? (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}
      {state.notice ? (
        <Alert>
          <AlertDescription>{state.notice}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={!canSync || pending}>
        <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
        {pending ? "Syncing…" : "Sync now"}
      </Button>
    </form>
  );
}
