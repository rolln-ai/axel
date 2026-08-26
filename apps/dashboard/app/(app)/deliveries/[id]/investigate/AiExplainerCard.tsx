"use client";

import { useActionState, useEffect, useRef } from "react";
import { Sparkles } from "lucide-react";
import {
  explainDeadLetter,
  type ActionState,
} from "../../../../../lib/dead-letter-explain";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

interface Props {
  deadLetterId: string;
  /** Cached explanation rendered on first paint when present. */
  initialSummary?: string | null;
  initialSuggestedAction?: string | null;
  initialSummarizedAt?: string | null;
}

export function AiExplainerCard({
  deadLetterId,
  initialSummary,
  initialSuggestedAction,
  initialSummarizedAt,
}: Props) {
  const hasInitialSummary = Boolean(initialSummary);
  const [state, action, pending] = useActionState<ActionState, FormData>(
    explainDeadLetter,
    initialSummary
      ? {
          notice: initialSummarizedAt
            ? `Cached explanation from ${initialSummarizedAt}.`
            : "Cached explanation.",
          data: {
            summary: initialSummary,
            suggested_action: initialSuggestedAction ?? "",
            cached: true,
          },
        }
      : {},
  );
  const autoRequested = useRef(false);
  const autoFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (hasInitialSummary || autoRequested.current) return;

    autoRequested.current = true;
    autoFormRef.current?.requestSubmit();
  }, [hasInitialSummary]);

  const summary = state.data?.summary;
  const suggestedAction = state.data?.suggested_action;
  const showManualAction = Boolean(summary || state.error);

  return (
    <section className="mb-6 rounded-md border border-border bg-card p-4">
      <form ref={autoFormRef} action={action} className="hidden">
        <input type="hidden" name="dead_letter_id" value={deadLetterId} />
      </form>

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Sparkles className="size-3.5 text-primary" /> Explain this failure
        </h2>
        {pending ? (
          <Button type="button" variant="outline" size="sm" disabled>
            Asking…
          </Button>
        ) : showManualAction ? (
          <form action={action}>
            <input type="hidden" name="dead_letter_id" value={deadLetterId} />
            {/* Re-ask bypasses the cached row and re-calls the LLM. */}
            {summary ? <input type="hidden" name="force" value="1" /> : null}
            <Button type="submit" variant="outline" size="sm">
              {summary ? "Re-ask" : "Try again"}
            </Button>
          </form>
        ) : null}
      </div>

      {state.error ? (
        <Alert variant="destructive" className="mb-3">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      ) : null}

      {summary ? (
        <div className="space-y-3">
          <div>
            <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Likely cause
            </h3>
            <p className="text-sm text-foreground">{summary}</p>
          </div>
          {suggestedAction ? (
            <div>
              <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Suggested next step
              </h3>
              <p className="text-sm text-foreground">{suggestedAction}</p>
            </div>
          ) : null}
          {state.data?.cached ? (
            <p className="text-xs text-muted-foreground">
              Cached — click <em>Re-ask</em> to regenerate. Re-asks overwrite the cache.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Generated from the event payload (PII redacted) + the failure reason. Cached against
              the dead-letter row.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Asking Claude to summarise the root cause and suggest a next step. The prompt redacts
          common PII patterns before send. The result is cached so repeat visits are free.
        </p>
      )}
    </section>
  );
}
