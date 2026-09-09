"use client";

import { useState } from "react";
import type { SchemaEvolution } from "@axel/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { createPostgresTable } from "../../../../lib/destination-binding-actions";
import { str } from "./helpers";
import { useTargetPicker } from "./hooks";
import { CreateTargetRow, ExistingTargetSelect, TargetPickerShell } from "./TargetPickerShell";
import { SchemaEvolutionPicker } from "./SchemaEvolutionPicker";

export function PostgresPicker({
  destinationId,
  destinationName,
  initialBinding,
}: {
  destinationId: string;
  destinationName: string;
  initialBinding?: Record<string, unknown> | null;
}) {
  const picker = useTargetPicker(destinationId, str(initialBinding?.table));
  const table = picker.target;
  // New wiring defaults to dotted_columns (auto-expand); an existing binding
  // keeps whatever it was explicitly saved as (e.g. legacy jsonb_blob).
  const initialMode = initialBinding?.mode === "jsonb_blob" ? "jsonb_blob" : "dotted_columns";
  const [mode, setMode] = useState<"jsonb_blob" | "dotted_columns">(initialMode);
  const [payloadColumn, setPayloadColumn] = useState(str(initialBinding?.payload_column, "payload"));
  const [schemaEvolution, setSchemaEvolution] = useState<SchemaEvolution>(initialBinding?.schema_evolution === "add_columns" ? "add_columns" : "manual");
  const modeId = `pg-mode-${destinationId}`;
  const columnId = `pg-column-${destinationId}`;

  const binding = table
    ? mode === "jsonb_blob"
      ? { table, mode, payload_column: payloadColumn || "payload" }
      : { table, mode, schema_evolution: schemaEvolution }
    : null;

  return (
    <TargetPickerShell
      destinationId={destinationId}
      destinationName={destinationName}
      heading="table"
      groupLabel="table binding"
      binding={binding}
      reload={{ loading: picker.loading, onReload: picker.reload, ariaLabel: "Reload table list" }}
    >
      {picker.loadErr ? (
        <p className="text-destructive">Couldn't list tables: {picker.loadErr}</p>
      ) : null}
      <p className="text-xs font-medium text-muted-foreground">Pick existing</p>
      <ExistingTargetSelect
        targets={picker.targets}
        loading={picker.loading}
        selected={picker.selected}
        onPick={picker.pick}
        triggerAriaLabel={`${destinationName} — table`}
        placeholders={{
          loading: "Loading tables…",
          pick: "Pick existing table…",
          empty: "(no tables yet)",
        }}
        savedMissingNote="Showing the saved table even though it was not returned by the latest table scan."
      />
      <CreateTargetRow
        draft={picker.draft}
        onDraftChange={picker.setDraft}
        inputAriaLabel="New table name"
        placeholder="new_table_name"
        pending={picker.pending}
        onCreate={() => picker.runCreate((name) => createPostgresTable(destinationId, name))}
        createError={picker.createError}
        createSuccess={picker.createSuccess}
      />
      <p className="text-xs text-muted-foreground">
        New tables are created in the <code>public</code> schema. To target a different schema (e.g.{" "}
        <code>app.events</code>), create it in Postgres first, then click Refresh to pick it.
      </p>
      <p className="text-muted-foreground">
        {mode === "dotted_columns"
          ? "Each top-level and nested key in the payload maps to its own column using dot notation. Existing columns must have compatible types."
          : "Each event becomes one row with the whole payload in this JSONB column."}
      </p>
      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={modeId} className="self-center text-xs text-muted-foreground">Mode</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <SelectTrigger id={modeId} className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="dotted_columns">Dot-notation columns</SelectItem>
            <SelectItem value="jsonb_blob">Single JSONB column (store whole payload as JSON)</SelectItem>
          </SelectContent>
        </Select>
        {mode === "jsonb_blob" ? (
          <>
            <Label htmlFor={columnId} className="self-center text-xs text-muted-foreground">Column</Label>
            <Input
              id={columnId}
              value={payloadColumn}
              onChange={(e) => setPayloadColumn(e.target.value)}
              placeholder="payload"
              className="h-8 font-mono text-xs"
            />
          </>
        ) : null}
      </div>
      {mode === "dotted_columns" ? <SchemaEvolutionPicker id={`pg-schema-${destinationId}`} value={schemaEvolution} onChange={setSchemaEvolution} /> : null}
    </TargetPickerShell>
  );
}
