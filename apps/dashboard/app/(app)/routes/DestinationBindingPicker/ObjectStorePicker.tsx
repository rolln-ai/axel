"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_KEY_TEMPLATE, DEFAULT_PARQUET_KEY_TEMPLATE, str } from "./helpers";
import { TargetPickerShell } from "./TargetPickerShell";

export function ObjectStorePicker({
  destinationId,
  destinationName,
  destinationType,
  initialBinding,
}: {
  destinationId: string;
  destinationName: string;
  destinationType: string;
  initialBinding?: Record<string, unknown> | null;
}) {
  const [keyPrefix, setKeyPrefix] = useState(str(initialBinding?.key_prefix));
  const [keyTemplate, setKeyTemplate] = useState(str(initialBinding?.key_template, ""));
  const [format, setFormat] = useState<"json" | "parquet">(
    !isR2Binding(destinationType) && initialBinding?.format === "parquet" ? "parquet" : "json",
  );
  const prefixId = `obj-prefix-${destinationId}`;
  const templateId = `obj-template-${destinationId}`;
  const formatId = `obj-format-${destinationId}`;
  const isR2 = destinationType === "r2";
  const defaultTemplate = format === "parquet" ? DEFAULT_PARQUET_KEY_TEMPLATE : DEFAULT_KEY_TEMPLATE;

  const binding = keyPrefix || keyTemplate || (!isR2 && format === "parquet")
    ? {
        ...(keyPrefix ? { key_prefix: keyPrefix } : {}),
        ...(keyTemplate && keyTemplate !== defaultTemplate ? { key_template: keyTemplate } : {}),
        ...(!isR2 && format === "parquet" ? { format } : {}),
      }
    : null;

  return (
    <TargetPickerShell
      destinationId={destinationId}
      destinationName={destinationName}
      heading="key prefix"
      groupLabel="key prefix binding"
      binding={binding}
    >
      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={prefixId} className="self-center text-xs text-muted-foreground">Key prefix</Label>
        <Input
          id={prefixId}
          value={keyPrefix}
          onChange={(e) => setKeyPrefix(e.target.value)}
          placeholder="axel/events/"
          className="h-8 font-mono text-xs"
        />
        {!isR2 && (
          <>
            <Label htmlFor={formatId} className="self-center text-xs text-muted-foreground">
              Format
            </Label>
            <Select value={format} onValueChange={(v) => setFormat(v === "parquet" ? "parquet" : "json")}>
              <SelectTrigger id={formatId} className="h-8 text-xs" aria-label={`${destinationName} — format`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">JSON</SelectItem>
                <SelectItem value="parquet">Parquet</SelectItem>
              </SelectContent>
            </Select>
            <Label htmlFor={templateId} className="self-center text-xs text-muted-foreground">
              Key template (default: <code>{defaultTemplate}</code>)
            </Label>
            <Input
              id={templateId}
              value={keyTemplate}
              onChange={(e) => setKeyTemplate(e.target.value)}
              placeholder="Leave blank for default"
              className="h-8 font-mono text-xs"
            />
          </>
        )}
      </div>
      {isR2 ? (
        <p className="text-muted-foreground">
          Files will be stored at{" "}
          <code className="font-mono">
            {keyPrefix}/&lt;workspace_id&gt;/YYYY-MM-DD/&lt;event_id&gt;-&lt;destination_id&gt;.json
          </code>
        </p>
      ) : (
        <p className="text-muted-foreground">
          Example key:{" "}
          <code className="font-mono">
            {((keyPrefix || "") + (keyTemplate || defaultTemplate))
              .replace("{date}", "YYYY-MM-DD")
              .replace("{event_id}", "evt_…")
              .replace("{batch_id}", "batch_…")}
          </code>
        </p>
      )}
      <p className="text-muted-foreground">
        {isR2 ? (
          <>
            Files are stored at{" "}
            <code>
              &lt;key_prefix&gt;/&lt;workspace_id&gt;/YYYY-MM-DD/&lt;event_id&gt;-&lt;destination_id&gt;.json
            </code>{" "}
            inside the managed bucket. Only the prefix is customisable for R2.
          </>
        ) : (
          <>
            Files are stored at <code>&lt;key_prefix&gt;&lt;key_template&gt;</code> inside the bucket
            configured on this destination. Variables: <code>{"{date}"}</code> (YYYY-MM-DD),{" "}
            {format === "parquet" ? <code>{"{batch_id}"}</code> : <code>{"{event_id}"}</code>}.
          </>
        )}
      </p>
      <p className="text-muted-foreground">
        An omitted prefix writes with no namespace; setting one is recommended for buckets shared
        across routes.
      </p>
    </TargetPickerShell>
  );
}

function isR2Binding(destinationType: string): boolean {
  return destinationType === "r2";
}
