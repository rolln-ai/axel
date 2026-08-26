"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WEBHOOK_SOURCE_TYPE } from "../helpers";
import { InboundProviderFields, SyncBehaviorNotice } from "./shared";

/**
 * Step 1 — source type + name + inbound provider. Rendered inside the wizard's
 * single <form>; hidden (not unmounted) on later steps so field state survives
 * step transitions.
 */
export function SourceStep({
  sourceName,
  onSourceNameChange,
}: {
  sourceName: string;
  onSourceNameChange: (name: string) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label>Source type</Label>
        <div className="flex items-start gap-3 rounded-md border border-input bg-muted/30 p-3">
          <span
            className="grid size-9 shrink-0 place-items-center rounded-md bg-primary/10 text-primary"
            aria-hidden="true"
          >
            <WEBHOOK_SOURCE_TYPE.icon className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">
                {WEBHOOK_SOURCE_TYPE.label}
              </span>
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                focused
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {WEBHOOK_SOURCE_TYPE.description}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="pipeline-source-name">Source name</Label>
        <Input
          id="pipeline-source-name"
          name="source_name"
          value={sourceName}
          onChange={(e) => onSourceNameChange(e.target.value)}
          required
          minLength={2}
          maxLength={64}
          placeholder="webhook-prod"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <InboundProviderFields />

      <SyncBehaviorNotice />
    </>
  );
}
