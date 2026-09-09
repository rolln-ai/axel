"use client";

import { useEffect, useState, useTransition } from "react";
import type { SchemaEvolution } from "@axel/shared";
import { Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  checkBigQueryCompatibilityAction,
  listSampleableStreamsAction,
  type BigQueryCompatCheck,
  type BqDeliveredRowPreview,
} from "../../../../lib/destination-binding-actions";
import {
  bigQueryModeForBinding,
  type BigQueryWriteMode,
} from "../../../../lib/pipeline-binding";
import { str } from "./helpers";

function BigQueryCompatResult({ check, schemaEvolution }: { check: BigQueryCompatCheck; schemaEvolution: SchemaEvolution }) {
  if (!check.ok) {
    return <p className="text-xs text-destructive">{check.error}</p>;
  }
  const events = (n: number) => `${n} event${n === 1 ? "" : "s"}`;
  const cols = (n: number) => `${n} new column${n === 1 ? "" : "s"}`;
  if (check.kind === "table_missing") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="size-3 shrink-0" />
        This table doesn&apos;t exist yet — Axel will create it, so it&apos;s compatible.
      </p>
    );
  }
  if (check.kind === "table_only") {
    if (check.mode === "typed_records") {
      return (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3 shrink-0 text-amber-600 dark:text-amber-400" />
          The table has {check.fieldCount} declared column{check.fieldCount === 1 ? "" : "s"}. Typed mode can target
          these, but there are no recent events to prove the incoming field types match yet. Re-check after loading a sample.
        </p>
      );
    }
    // No events to diff against — flag the table's typed (non-STRING) columns,
    // which is the shape-independent part of the risk.
    if (check.typed.length === 0) {
      return (
        <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <ShieldCheck className="size-3 shrink-0" />
          Table has {check.fieldCount} column{check.fieldCount === 1 ? "" : "s"}, all STRING/RECORD.
          A sample is still needed to check field names, objects, and arrays.
        </p>
      );
    }
    return (
      <div className="space-y-1.5 text-xs">
        <p className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
          <TriangleAlert className="size-3 shrink-0" />
          {check.typed.length} typed column{check.typed.length === 1 ? "" : "s"} — Axel writes every scalar as
          STRING, so rows targeting these would be rejected:
        </p>
        <ul className="space-y-0.5">
          {check.typed.slice(0, 12).map((c) => (
            <TypeConflictRow key={c.path} path={c.path} axel="STRING" column={c.type} />
          ))}
        </ul>
        {check.typed.length > 12 ? (
          <p className="text-muted-foreground">…and {check.typed.length - 12} more.</p>
        ) : null}
        <p className="text-muted-foreground">
          Use a new/empty table, or send events and re-check to compare the actual event shape.
        </p>
      </div>
    );
  }
  const { result, sampled } = check;
  if (result.compatible && result.additions.length > 0 && schemaEvolution !== "add_columns") {
    return (
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Schema update required: {cols(result.additions.length)} in {events(sampled)} sampled.
        Axel will leave the table unchanged and send these events to failed deliveries.
        Review downstream views, add the fields and replay, or explicitly allow new fields.
      </p>
    );
  }
  if (result.compatible) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="size-3 shrink-0" />
        Compatible — sampled {events(sampled)}; every field fits
        {result.additions.length > 0 ? ` (${cols(result.additions.length)} will be added; review downstream views first)` : ""}.
      </p>
    );
  }
  return (
    <div className="space-y-1.5 text-xs">
      <p className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <TriangleAlert className="size-3 shrink-0" />
        {result.conflicts.length} schema conflict{result.conflicts.length === 1 ? "" : "s"} (sampled{" "}
        {events(sampled)}) — these incoming fields do not match the target table and would be rejected:
      </p>
      <ul className="space-y-0.5">
        {result.conflicts.slice(0, 12).map((c) => (
          <TypeConflictRow key={c.path} path={c.path} axel={c.expected} column={c.existing} />
        ))}
      </ul>
      {result.conflicts.length > 12 ? (
        <p className="text-muted-foreground">…and {result.conflicts.length - 12} more.</p>
      ) : null}
      {result.additions.length > 0 ? (
        <p className="text-muted-foreground">{cols(result.additions.length)} also need a schema update. Review downstream views before allowing additions.</p>
      ) : null}
    </div>
  );
}

/** One scannable conflict row: field path on the left, `axel → column` types on the right. */
function TypeConflictRow({ path, axel, column }: { path: string; axel: string; column: string }) {
  return (
    <li className="flex items-baseline justify-between gap-3">
      <code className="break-all font-mono text-foreground">{path}</code>
      <span className="shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
        {axel} <span className="text-amber-600 dark:text-amber-400">→</span> {column}
      </span>
    </li>
  );
}

/**
 * Unified BigQuery compatibility + delivered-row preview panel, shared by the
 * route-wiring form (BigQueryPicker) and the canvas node (BigQueryNodeCompat).
 *
 * The operator picks which existing stream to sample a real event from — so a
 * destination being wired to a brand-new source can still be validated by
 * borrowing events from a stream that's already flowing (e.g. their bronze
 * pipeline). Shows the compatibility verdict plus the exact row Axel would
 * write for a sampled event.
 */
export function BigQueryCompatPanel({
  destinationId,
  defaultSourceId,
  dataset,
  table,
  mode,
  payloadColumn,
  schemaEvolution = "manual",
}: {
  destinationId: string;
  defaultSourceId?: string;
  dataset?: string;
  table: string;
  mode: BigQueryWriteMode;
  payloadColumn?: string;
  schemaEvolution?: SchemaEvolution;
}) {
  const [streams, setStreams] = useState<Array<{ id: string; name: string }>>([]);
  const [streamId, setStreamId] = useState(defaultSourceId ?? "");
  const [compat, setCompat] = useState<BigQueryCompatCheck | null>(null);
  const [checking, startCheck] = useTransition();

  // Load the workspace streams once so the operator can choose which one to
  // sample from (defaults to the route's own source when present, else the
  // most recently updated stream).
  useEffect(() => {
    let active = true;
    listSampleableStreamsAction().then((res) => {
      if (!active || !res.ok) return;
      setStreams(res.streams);
      setStreamId((cur) => cur || defaultSourceId || res.streams[0]?.id || "");
    });
    return () => {
      active = false;
    };
  }, [defaultSourceId]);

  // A prior result is stale once the target, mode, or sampled stream changes.
  useEffect(() => {
    setCompat(null);
  }, [table, dataset, mode, payloadColumn, streamId]);

  const run = () => {
    startCheck(async () => {
      setCompat(
        await checkBigQueryCompatibilityAction({
          destinationId,
          ...(streamId ? { sourceId: streamId } : {}),
          ...(dataset ? { dataset } : {}),
          table,
          mode,
          ...(payloadColumn ? { payloadColumn } : {}),
        }),
      );
    });
  };

  const targetLabel = dataset ? `${dataset}.${table}` : table;
  const streamName = streams.find((s) => s.id === streamId)?.name;
  const preview =
    compat?.ok && (compat.kind === "checked" || compat.kind === "table_missing")
      ? compat.preview
      : undefined;

  return (
    <div className="space-y-2 border-t border-border/60 pt-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={run}
          disabled={checking}
        >
          {checking ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
          Check compatibility &amp; preview
        </Button>
        {streams.length > 0 ? (
          <div className="flex items-center gap-1 text-muted-foreground">
            <span>sampling</span>
            <Select value={streamId} onValueChange={setStreamId}>
              <SelectTrigger
                className="h-7 min-w-[8rem] text-xs"
                aria-label="Stream to sample a test event from"
              >
                <SelectValue placeholder="a stream…" />
              </SelectTrigger>
              <SelectContent>
                {streams.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>
      {compat ? <BigQueryCompatResult check={compat} schemaEvolution={schemaEvolution} /> : null}
      {preview ? (
        <DeliveredRowPreview preview={preview} target={targetLabel} streamName={streamName} />
      ) : null}
    </div>
  );
}

function DeliveredRowPreview({
  preview,
  target,
  streamName,
}: {
  preview: BqDeliveredRowPreview;
  target: string;
  streamName?: string;
}) {
  return (
    <div className="space-y-1 text-xs">
      <p className="text-muted-foreground">
        Sample event from{" "}
        {streamName ? <span className="text-foreground">{streamName}</span> : "the stream"} → row Axel
        would write to <code className="font-mono text-foreground">{target}</code>:
      </p>
      {preview.row ? (
        <pre className="max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(preview.row, null, 2)}
        </pre>
      ) : (
        <p className="text-amber-600 dark:text-amber-400">
          This event can&apos;t be shaped for the chosen write mode — Axel would dead-letter it.
        </p>
      )}
      <details className="text-muted-foreground">
        <summary className="cursor-pointer select-none">Show the source event</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(preview.event, null, 2)}
        </pre>
      </details>
    </div>
  );
}

/**
 * Compatibility check + delivered-row preview for a BigQuery destination node in
 * the pipeline canvas. The binding is already saved here, so we read the
 * dataset/table/mode from it and delegate to the shared panel.
 */
export function BigQueryNodeCompat({
  sourceId,
  destinationId,
  binding,
}: {
  sourceId?: string;
  destinationId: string;
  binding?: Record<string, unknown> | null;
}) {
  const table = str(binding?.table).trim();
  const dataset = str(binding?.dataset).trim();
  const mode = bigQueryModeForBinding(binding);
  const payloadColumn = str(binding?.payload_column);

  if (!table) {
    return (
      <p className="border-t border-border pt-3 text-[11px] text-muted-foreground">
        No BigQuery table bound yet — set one on the Destinations tab to check compatibility.
      </p>
    );
  }

  return (
    <BigQueryCompatPanel
      destinationId={destinationId}
      {...(sourceId ? { defaultSourceId: sourceId } : {})}
      {...(dataset ? { dataset } : {})}
      table={table}
      mode={mode}
      schemaEvolution={binding?.schema_evolution === "add_columns" ? "add_columns" : "manual"}
      {...(payloadColumn ? { payloadColumn } : {})}
    />
  );
}
