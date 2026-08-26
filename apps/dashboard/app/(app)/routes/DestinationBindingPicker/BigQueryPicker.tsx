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
import {
  listBigQueryDatasetsAction,
  listBigQueryTablesAction,
} from "../../../../lib/destination-binding-actions";
import { BigQueryDatasetTablePicker } from "@/components/bigquery-dataset-table-picker";
import {
  bigQueryModeForBinding,
  type BigQueryWriteMode,
} from "../../../../lib/pipeline-binding";
import { str } from "./helpers";
import { BigQueryCompatPanel } from "./BigQueryCompat";
import { TargetPickerShell } from "./TargetPickerShell";

export function BigQueryPicker({
  destinationId,
  destinationName,
  initialBinding,
  sourceId,
}: {
  destinationId: string;
  destinationName: string;
  initialBinding?: Record<string, unknown> | null;
  sourceId?: string;
}) {
  const [dataset, setDataset] = useState(str(initialBinding?.dataset));
  const [table, setTable] = useState(str(initialBinding?.table));
  const [mode, setMode] = useState<BigQueryWriteMode>(() =>
    bigQueryModeForBinding(initialBinding),
  );
  const [payloadColumn, setPayloadColumn] = useState(str(initialBinding?.payload_column, "payload"));
  const modeId = `bq-mode-${destinationId}`;
  const payloadColumnId = `bq-payload-${destinationId}`;

  const ds = dataset.trim();
  const tbl = table.trim();
  // BigQuery bindings carry both dataset + table (the destination is auth-only).
  const binding =
    ds && tbl
      ? mode === "json_column"
        ? { dataset: ds, table: tbl, mode, payload_column: payloadColumn || "payload" }
        : { dataset: ds, table: tbl, mode }
      : null;

  return (
    <TargetPickerShell
      destinationId={destinationId}
      destinationName={destinationName}
      heading="BigQuery dataset + table"
      groupLabel="BigQuery dataset and table binding"
      binding={binding}
    >
      <BigQueryDatasetTablePicker
        idPrefix={`bq-${destinationId}`}
        dataset={dataset}
        table={table}
        onDatasetChange={setDataset}
        onTableChange={setTable}
        autoLoadKey={destinationId}
        listDatasets={() => listBigQueryDatasetsAction({ destinationId })}
        listTables={(d) => listBigQueryTablesAction({ destinationId, dataset: d })}
      />

      <div className="grid gap-2 sm:grid-cols-[auto_1fr]">
        <Label htmlFor={modeId} className="self-center text-xs text-muted-foreground">Write mode</Label>
        <Select value={mode} onValueChange={(v) => setMode(v as BigQueryWriteMode)}>
          <SelectTrigger id={modeId} className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-w-[22rem]">
            <SelectItem
              value="typed_records"
              description={
                <>
                  <span className="text-emerald-600 dark:text-emerald-400">Recommended.</span> Keeps source
                  types — numbers → INT64/FLOAT64, booleans → BOOL, objects → RECORD. Best for a clean or
                  existing typed table.
                </>
              }
            >
              Typed RECORD fields
            </SelectItem>
            <SelectItem
              value="nested_records"
              description="Every value stored as STRING in a nested RECORD shape. Most tolerant — never rejects on type drift."
            >
              Nested RECORD fields
            </SelectItem>
            <SelectItem
              value="columns"
              description="One underscore-joined STRING column per leaf, e.g. data_subscriber_email."
            >
              Flat STRING columns
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
        {mode === "nested_records"
          ? "Use a new/empty table or one whose existing RECORD schema is compatible. Axel maps objects to RECORD fields, normalizes scalar leaves to STRING, maps object arrays to REPEATED RECORD, and additively evolves nested keys."
          : mode === "typed_records"
            ? "Like nested RECORD, but scalar leaves keep the source type: numbers → INT64/FLOAT64, booleans → BOOL, strings → STRING. Best for a clean, stable schema or an existing typed table. A field whose type drifts on an existing column can't be widened (BigQuery limitation) and dead-letters, so run the compatibility check below first."
            : mode === "columns"
              ? "Axel flattens each JSON leaf into an underscore-joined STRING column (for example, data_subscriber_email). It creates the table when needed and adds new columns automatically."
              : "Axel stores each event's JSON body in one STRING column. It creates the table and payload column when the table does not exist."}
      </p>
      {ds && tbl ? (
        <BigQueryCompatPanel
          destinationId={destinationId}
          {...(sourceId ? { defaultSourceId: sourceId } : {})}
          dataset={ds}
          table={tbl}
          mode={mode}
          payloadColumn={payloadColumn}
        />
      ) : null}
    </TargetPickerShell>
  );
}
