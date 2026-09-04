"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { updateSourceLimits } from "../../../../lib/source-actions";
import type { ActionState } from "../../../../lib/action-data";
import { DEFAULT_SOURCE_LIMITS } from "../../../../lib/source-defaults";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  sourceId: string;
  initialMaxEventsPerMinute: number | null;
  initialMaxBodyBytes: number | null;
  initialMaxBodyDepth: number | null;
}

export function LimitsEditor({
  sourceId,
  initialMaxEventsPerMinute,
  initialMaxBodyBytes,
  initialMaxBodyDepth,
}: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState<ActionState, FormData>(
    updateSourceLimits,
    {},
  );

  const [rate, setRate] = useState<string>(initialMaxEventsPerMinute?.toString() ?? "");
  const [bodyBytes, setBodyBytes] = useState<string>(initialMaxBodyBytes?.toString() ?? "");
  const [bodyDepth, setBodyDepth] = useState<string>(initialMaxBodyDepth?.toString() ?? "");

  useEffect(() => {
    if (state.notice && !state.error) router.refresh();
  }, [state.notice, state.error, router]);

  const ratePlaceholder = initialMaxEventsPerMinute === null
    ? `default (${DEFAULT_SOURCE_LIMITS.maxEventsPerMinute.toLocaleString()})`
    : "type 'default' to revert";
  const bodyPlaceholder = initialMaxBodyBytes === null
    ? `default (${DEFAULT_SOURCE_LIMITS.maxBodyBytes.toLocaleString()})`
    : "type 'default' to revert";
  const depthPlaceholder = initialMaxBodyDepth === null
    ? `default (${DEFAULT_SOURCE_LIMITS.maxBodyDepth})`
    : "type 'default' to revert";

  return (
    <form action={formAction} className="space-y-5">
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

      <Field
        label="Rate cap"
        unit="events / minute"
        hint="Per-source token-bucket limit applied at the ingest edge. Up to 1,000,000/min. For high-volume producers such as Stripe or Segment, start with 100,000 to 600,000."
      >
        <Input
          name="max_events_per_minute"
          type="text"
          inputMode="numeric"
          value={rate}
          onChange={(e) => setRate(e.target.value)}
          placeholder={ratePlaceholder}
          disabled={pending}
        />
      </Field>

      <Field
        label="Max body size"
        unit="bytes per request"
        hint="Requests with a larger body are rejected with 413. Hard ceiling is 25 MB — set higher only if you ingest fat payloads (e.g. inline base64 attachments)."
      >
        <Input
          name="max_body_bytes"
          type="text"
          inputMode="numeric"
          value={bodyBytes}
          onChange={(e) => setBodyBytes(e.target.value)}
          placeholder={bodyPlaceholder}
          disabled={pending}
        />
      </Field>

      <Field
        label="Max JSON depth"
        unit="levels"
        hint="Pathological nesting beyond this depth is rejected with 400. 100 covers virtually every webhook payload in the wild."
      >
        <Input
          name="max_body_depth"
          type="text"
          inputMode="numeric"
          value={bodyDepth}
          onChange={(e) => setBodyDepth(e.target.value)}
          placeholder={depthPlaceholder}
          disabled={pending}
        />
      </Field>

      <div className="grid gap-2 border-t border-border pt-4 md:grid-cols-[200px_1fr] md:gap-6">
        <div className="hidden md:block" />
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Saving…" : "Save limits"}
          </Button>
          <small className="text-xs text-muted-foreground">
            Empty field = no change. Type{" "}
            <code className="rounded-sm bg-muted px-1 font-mono text-xs">default</code> to revert.
          </small>
        </div>
      </div>
    </form>
  );
}

function Field({
  label,
  unit,
  hint,
  children,
}: {
  label: string;
  unit: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 md:grid-cols-[200px_1fr] md:gap-6 md:items-start">
      <Label className="pt-2 text-sm font-medium">{label}</Label>
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <div className="flex-1">{children}</div>
          <span className="text-xs text-muted-foreground">{unit}</span>
        </div>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
