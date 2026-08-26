"use client";

import { useState } from "react";
import { FileJson } from "lucide-react";
import { fetchDeadLetterPayload } from "../../../../../lib/replay-actions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useAction } from "../../../../_components/useAction";

/**
 * On-demand reveal of the dead letter's raw payload (fetched from R2 via the
 * fetchDeadLetterPayload server action). The payload isn't loaded with the
 * page — it can be large, and most investigations resolve without it — so
 * it's a click-to-fetch panel using the shared `useAction` direct-call
 * convention.
 */
export function RevealPayloadPanel({ deadLetterId }: { deadLetterId: string }) {
  const fetchPayload = useAction(fetchDeadLetterPayload);
  const [hidden, setHidden] = useState(false);
  const { pending: loading, result } = fetchPayload;

  function handleReveal() {
    setHidden(false);
    fetchPayload.run(deadLetterId);
  }

  if (!result || hidden) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-3 h-7"
        onClick={result ? () => setHidden(false) : handleReveal}
        disabled={loading}
      >
        <FileJson className="mr-1 size-3" />
        {loading ? "Loading payload…" : "Reveal payload"}
      </Button>
    );
  }

  if (result.error) {
    return (
      <Alert variant="destructive" className="mt-3">
        <AlertDescription className="flex flex-wrap items-center gap-2">
          <span>{result.error}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6"
            onClick={handleReveal}
            disabled={loading}
          >
            {loading ? "Loading…" : "Try again"}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="mt-3 space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          <FileJson className="size-3" /> Payload as received
          {result.r2_key ? (
            <span className="font-mono font-normal normal-case tracking-normal">
              ({result.r2_key})
            </span>
          ) : null}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => setHidden(true)}
        >
          Hide
        </Button>
      </div>
      <pre className="max-h-80 overflow-auto rounded-sm bg-muted p-2 font-mono text-[10px]">
        {JSON.stringify(result.payload, null, 2)}
      </pre>
    </div>
  );
}
