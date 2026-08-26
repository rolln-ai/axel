"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DEFAULT_KEY_TEMPLATE, str } from "./helpers";
import { TargetPickerShell } from "./TargetPickerShell";

export function DatabricksVolumePicker({
  destinationId,
  destinationName,
  initialBinding,
}: {
  destinationId: string;
  destinationName: string;
  initialBinding?: Record<string, unknown> | null;
}) {
  const [volume, setVolume] = useState(str(initialBinding?.volume));
  const [keyPrefix, setKeyPrefix] = useState(str(initialBinding?.key_prefix));
  const [keyTemplate, setKeyTemplate] = useState(str(initialBinding?.key_template, ""));
  const volumeId = `dbx-vol-volume-${destinationId}`;
  const prefixId = `dbx-vol-prefix-${destinationId}`;
  const templateId = `dbx-vol-template-${destinationId}`;

  const binding = volume
    ? {
        volume,
        ...(keyPrefix ? { key_prefix: keyPrefix } : {}),
        ...(keyTemplate && keyTemplate !== DEFAULT_KEY_TEMPLATE ? { key_template: keyTemplate } : {}),
      }
    : null;

  return (
    <TargetPickerShell
      destinationId={destinationId}
      destinationName={destinationName}
      heading="volume"
      groupLabel="volume binding"
      binding={binding}
    >
      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={volumeId} className="self-center text-xs text-muted-foreground">
          Volume <span aria-hidden="true">*</span>
        </Label>
        <Input
          id={volumeId}
          aria-required="true"
          value={volume}
          onChange={(e) => setVolume(e.target.value)}
          placeholder="webhooks_landing"
          className="h-8 font-mono text-xs"
        />
        <Label htmlFor={prefixId} className="self-center text-xs text-muted-foreground">Key prefix</Label>
        <Input
          id={prefixId}
          value={keyPrefix}
          onChange={(e) => setKeyPrefix(e.target.value)}
          placeholder="(optional, e.g. events/)"
          className="h-8 font-mono text-xs"
        />
        <Label htmlFor={templateId} className="self-center text-xs text-muted-foreground">
          Key template (default: <code>{DEFAULT_KEY_TEMPLATE}</code>)
        </Label>
        <Input
          id={templateId}
          value={keyTemplate}
          onChange={(e) => setKeyTemplate(e.target.value)}
          placeholder="Leave blank for default"
          className="h-8 font-mono text-xs"
        />
      </div>
      <p className="text-muted-foreground">
        Example key:{" "}
        <code className="font-mono">
          {((keyPrefix || "") + (keyTemplate || DEFAULT_KEY_TEMPLATE))
            .replace("{date}", "YYYY-MM-DD")
            .replace("{event_id}", "evt_…")
            .replace("{destination_id}", "dst_…")}
        </code>
      </p>
      <p className="text-muted-foreground">
        Files are stored at <code>&lt;key_prefix&gt;&lt;key_template&gt;</code> inside the volume
        configured on this destination. Variables: <code>{"{date}"}</code> (YYYY-MM-DD),{" "}
        <code>{"{event_id}"}</code>, <code>{"{destination_id}"}</code>. One file is written per
        event (overwrite=true).
      </p>
      <p className="text-muted-foreground">
        An omitted prefix writes with no namespace; setting one is recommended when a volume is
        shared across routes.
      </p>
    </TargetPickerShell>
  );
}
