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
import { SchemaEvolutionPicker } from "./SchemaEvolutionPicker";

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
  const [schemaEvolution, setSchemaEvolution] = useState<SchemaEvolution>(initialBinding?.schema_evolution === "add_columns" ? "add_columns" : "manual");
  const modeId = `bq-mode-${destinationId}`;
  const payloadColumnId = `bq-payload-${destinationId}`;

  const ds = dataset.trim();
  const tbl = table.trim();
  // BigQuery bindings carry both dataset + table (the destination is auth-only).
  const binding =
    ds && tbl
      ? mode === "json_column"
        ? { dataset: ds, table: tbl, mode, schema_evolution: schemaEvolution, payload_column: payloadColumn || "payload" }
        : { dataset: ds, table: tbl, mode, schema_evolution: schemaEvolution }
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
                  types. New number fields use FLOAT64, booleans use BOOL, and objects use RECORD. Best for a clean or
                  existing typed table.
                </>
              }
            >
              Typed RECORD fields
            </SelectItem>
            <SelectItem
              value="nested_records"
              description="Scalar values stored as STRING in a nested RECORD shape. Object and array shapes still need compatible fields."
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
          ? "Use a new table or one whose existing RECORD schema is compatible. Axel maps objects to RECORD fields, normalizes scalar leaves to STRING, and maps object arrays to REPEATED RECORD."
          : mode === "typed_records"
            ? "Keeps numbers, booleans, strings, and nested objects in their native shapes. New numeric fields use FLOAT64. Existing column types stay unchanged; incompatible events go to failed deliveries for review and replay. Run the compatibility check before saving."
            : mode === "columns"
              ? "Axel flattens each JSON leaf into an underscore-joined STRING column (for example, data_subscriber_email). It creates the table when needed."
              : "Axel stores each event's JSON body in one STRING column. It creates the table and payload column when the table does not exist."}
      </p>
      <SchemaEvolutionPicker id={`bq-schema-${destinationId}`} value={schemaEvolution} onChange={setSchemaEvolution} />
      {ds && tbl ? (
        <BigQueryCompatPanel
          destinationId={destinationId}
          {...(sourceId ? { defaultSourceId: sourceId } : {})}
          dataset={ds}
          table={tbl}
          mode={mode}
          payloadColumn={payloadColumn}
          schemaEvolution={schemaEvolution}
        />
      ) : null}
    </TargetPickerShell>
  );
}
