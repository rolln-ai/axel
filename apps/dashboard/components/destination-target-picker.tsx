"use client";

import { useEffect, useState, useTransition } from "react";
import { Loader2, Plus } from "lucide-react";
import { BigQueryDatasetTablePicker } from "@/components/bigquery-dataset-table-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createMongoCollection,
  createPostgresTable,
  listBigQueryDatasetsAction,
  listBigQueryTablesAction,
  listDestinationTargets,
} from "../lib/destination-binding-actions";

/**
 * Target picker for Postgres, MongoDB, and BigQuery destinations. These store
 * the target as a per-route binding, not on the destination, so any flow that
 * introspects one (pipeline previews, data-contract mapping proposals) needs
 * it explicitly. Lists existing targets (best-effort) and lets the operator
 * pick one; Postgres and MongoDB can also create one inline. Mount with a key
 * tied to the destination so switching destinations reloads the list.
 */
export function DestinationTargetPicker({
  destinationId,
  destinationType,
  value,
  onChange,
}: {
  destinationId: string;
  destinationType: string;
  value: string;
  onChange: (value: string) => void;
}) {
  if (destinationType === "bigquery") {
    return (
      <BigQueryTargetPicker
        destinationId={destinationId}
        initialValue={value}
        onChange={onChange}
      />
    );
  }

  return (
    <ContainerTargetPicker
      destinationId={destinationId}
      destinationType={destinationType}
      value={value}
      onChange={onChange}
    />
  );
}

function BigQueryTargetPicker({
  destinationId,
  initialValue,
  onChange,
}: {
  destinationId: string;
  initialValue: string;
  onChange: (value: string) => void;
}) {
  const separator = initialValue.indexOf(".");
  const [dataset, setDataset] = useState(
    separator > 0 ? initialValue.slice(0, separator) : "",
  );
  const [table, setTable] = useState(
    separator > 0 ? initialValue.slice(separator + 1) : "",
  );

  return (
    <div className="space-y-1.5">
      <BigQueryDatasetTablePicker
        idPrefix={`target-${destinationId}`}
        dataset={dataset}
        table={table}
        onDatasetChange={(next) => {
          setDataset(next);
          setTable("");
          onChange("");
        }}
        onTableChange={(next) => {
          setTable(next);
          onChange(dataset.trim() && next.trim() ? `${dataset.trim()}.${next.trim()}` : "");
        }}
        autoLoadKey={destinationId}
        listDatasets={() => listBigQueryDatasetsAction({ destinationId })}
        listTables={(nextDataset) =>
          listBigQueryTablesAction({ destinationId, dataset: nextDataset })
        }
      />
      <p className="text-xs text-muted-foreground">
        The project comes from the destination. Pick its dataset, then an existing table or a new
        table name.
      </p>
    </div>
  );
}

function ContainerTargetPicker({
  destinationId,
  destinationType,
  value,
  onChange,
}: {
  destinationId: string;
  destinationType: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const noun =
    destinationType === "mongodb"
      ? "collection"
      : "table";
  const canCreate = destinationType === "mongodb" || destinationType === "postgres";
  const [existing, setExisting] = useState<string[]>([]);
  const [loading, startLoad] = useTransition();
  const [creating, startCreate] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const fieldId = `target-${destinationId}`;
  const listId = `${fieldId}-options`;

  // Load existing targets on mount. Best-effort: if listing fails (unreachable
  // DB, self-signed cert), the operator can still type a name — the mapping
  // preview surfaces the real error.
  useEffect(() => {
    startLoad(async () => {
      const result = await listDestinationTargets(destinationId);
      if (result.ok) setExisting(result.targets);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destinationId]);

  const trimmed = value.trim();
  const isNew = trimmed.length > 0 && !existing.includes(trimmed);

  function create() {
    if (!isNew) return;
    setMsg(null);
    startCreate(async () => {
      const result =
        destinationType === "mongodb"
          ? await createMongoCollection(destinationId, trimmed)
          : await createPostgresTable(destinationId, trimmed);
      if (result.ok) {
        setExisting((prev) => (prev.includes(result.name) ? prev : [...prev, result.name]));
        onChange(result.name);
        setMsg(`Created "${result.name}".`);
      } else {
        setMsg(result.error);
      }
    });
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId} className="text-xs font-medium text-muted-foreground">
        Target {noun}
      </Label>
      <div className="flex gap-2">
        <Input
          id={fieldId}
          list={listId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            loading
              ? "Loading targets…"
              : `Pick or name a ${noun}`
          }
          className="h-9 flex-1 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <datalist id={listId}>
          {existing.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {canCreate ? <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9"
          disabled={!isNew || creating}
          onClick={create}
          title={isNew ? `Create ${noun} "${trimmed}"` : undefined}
        >
          {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Create
        </Button> : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Where matching events land. Pick an existing {noun}, or type a new name and click Create.
      </p>
      {msg ? <p className="text-xs text-muted-foreground">{msg}</p> : null}
    </div>
  );
}
