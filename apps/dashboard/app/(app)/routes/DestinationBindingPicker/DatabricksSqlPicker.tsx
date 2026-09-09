"use client";

import { useState } from "react";
import type { SchemaEvolution } from "@axel/shared";
import { RefreshCw, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { str } from "./helpers";
import { useTargetList } from "./hooks";
import { ExistingTargetSelect, TargetPickerShell } from "./TargetPickerShell";
import { SchemaEvolutionPicker } from "./SchemaEvolutionPicker";

export function DatabricksSqlPicker({
  destinationId,
  destinationName,
  initialBinding,
}: {
  destinationId: string;
  destinationName: string;
  initialBinding?: Record<string, unknown> | null;
}) {
  const { targets, loadErr, loading, reload } = useTargetList(destinationId);
  const [table, setTable] = useState(str(initialBinding?.table));
  const [mode, setMode] = useState<"json_column" | "typed_columns">(
    // New wiring defaults to typed_columns; a saved binding keeps its mode
    // (a legacy binding with no mode stays json_column).
    initialBinding && initialBinding.mode !== "typed_columns" ? "json_column" : "typed_columns",
  );
  const [payloadColumn, setPayloadColumn] = useState(str(initialBinding?.payload_column, "payload"));
  const [schemaEvolution, setSchemaEvolution] = useState<SchemaEvolution>(initialBinding?.schema_evolution === "add_columns" ? "add_columns" : "manual");
  const payloadColumnId = `dbx-sql-payload-${destinationId}`;
  const modeId = `dbx-sql-mode-${destinationId}`;
  const tableId = `dbx-sql-table-${destinationId}`;

  const binding = table
    ? {
        table,
        mode,
        schema_evolution: schemaEvolution,
        ...(mode === "json_column" ? { payload_column: payloadColumn || "payload" } : {}),
      }
    : null;

  return (
    <TargetPickerShell
      destinationId={destinationId}
      destinationName={destinationName}
      heading="Delta table"
      groupLabel="Delta table binding"
      binding={binding}
      reload={{ loading, onReload: reload, ariaLabel: "Reload table list" }}
    >
      {loadErr ? (
        <div className="space-y-1">
          <p className="text-destructive">
            Couldn't list tables: {loadErr} Check that the access token has{" "}
            <code>USE SCHEMA</code> and <code>SELECT</code> privileges on the configured catalog and
            schema.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={reload}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Retry
          </Button>
        </div>
      ) : null}
      <ExistingTargetSelect
        targets={targets}
        loading={loading}
        selected={table}
        onPick={setTable}
        triggerId={tableId}
        triggerAriaLabel={`${destinationName} — Delta table`}
        placeholders={{
          loading: "Loading tables…",
          pick: "Pick table…",
          empty: "(no tables found in catalog/schema)",
        }}
        savedMissingNote="Showing the saved table even though it was not returned by the latest table scan."
      />
      {targets !== null && targets.length === 0 ? (
        <p className="text-muted-foreground">
          No tables found in the configured catalog/schema. Create one first, e.g.{" "}
          <code className="font-mono">
            CREATE TABLE catalog.schema.events (payload STRING)
          </code>
          , then click Refresh.{" "}
          <a
            href="https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-ddl-create-table"
            target="_blank"
            rel="noreferrer"
            className="underline"
          >
            CREATE TABLE docs
          </a>
        </p>
      ) : null}
      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={modeId} className="self-center text-xs text-muted-foreground">Write mode</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as "json_column" | "typed_columns")}>
          <SelectTrigger id={modeId} className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[22rem]">
            <SelectItem
              value="typed_columns"
              description={
                <>
                  <span className="text-emerald-600 dark:text-emerald-400">Recommended.</span> One typed column
                  per leaf. Numbers use DOUBLE and booleans use BOOLEAN when Axel creates the Delta table.
                </>
              }
            >
              Typed columns
            </SelectItem>
            <SelectItem
              value="json_column"
              description="The whole event body stored as one STRING column."
            >
              Single STRING column
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      {mode === "json_column" ? (
        <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
          <Label htmlFor={payloadColumnId} className="self-center text-xs text-muted-foreground">Payload column</Label>
          <Input
            id={payloadColumnId}
            value={payloadColumn}
            onChange={(e) => setPayloadColumn(e.target.value)}
            placeholder="payload"
            className="h-8 font-mono text-xs"
          />
        </div>
      ) : null}
      <p className="text-muted-foreground">
        {mode === "json_column"
          ? "Axel writes each event's JSON body into this STRING (or VARIANT) column. The table must already exist in the catalog and schema configured on this destination."
          : "Axel flattens each event into one typed column per leaf. It creates missing Delta tables. Events whose types conflict with existing columns go to failed deliveries for review and replay."}
      </p>
      {mode === "typed_columns" ? <SchemaEvolutionPicker id={`dbx-schema-${destinationId}`} value={schemaEvolution} onChange={setSchemaEvolution} /> : null}
    </TargetPickerShell>
  );
}
