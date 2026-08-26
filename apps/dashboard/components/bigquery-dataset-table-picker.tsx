"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Label } from "@/components/ui/label";
import type { BigQueryListResult } from "../lib/destination-binding-actions";

/**
 * Guided BigQuery dataset + table picker. Datasets are existing-only (Axel
 * doesn't create datasets); the table field lists existing tables in the chosen
 * dataset and also accepts a new name (the connector auto-creates the table on
 * first delivery).
 *
 * The caller supplies `listDatasets` / `listTables` bound to its source — a
 * saved destination (auto-loads on mount) or just-entered credentials from the
 * destination-creation form (loaded on demand via the button).
 */
export function BigQueryDatasetTablePicker({
  idPrefix,
  dataset,
  table,
  onDatasetChange,
  onTableChange,
  listDatasets,
  listTables,
  autoLoadKey,
}: {
  idPrefix: string;
  dataset: string;
  table: string;
  onDatasetChange: (value: string) => void;
  onTableChange: (value: string) => void;
  listDatasets: () => Promise<BigQueryListResult>;
  listTables: (dataset: string) => Promise<BigQueryListResult>;
  /**
   * Readiness signal for auto-loading datasets. Non-empty ⇒ the source is
   * listable, so load. A key already present on mount (a saved destination
   * passes its id) loads immediately; a key that appears later (the create
   * form passes a signature of the entered credentials, once the token parses)
   * loads after a short debounce and re-loads if it changes. Null/empty ⇒ no
   * auto-load — wait for the Load button.
   */
  autoLoadKey: string | null;
}) {
  const [datasets, setDatasets] = useState<string[]>([]);
  const [tables, setTables] = useState<string[]>([]);
  const [loadingDatasets, setLoadingDatasets] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [datasetError, setDatasetError] = useState<string | null>(null);
  const [tableError, setTableError] = useState<string | null>(null);
  // Keep the latest loaders in refs so the effects don't depend on their identity
  // (the caller re-creates the closures each render).
  const listDatasetsRef = useRef(listDatasets);
  listDatasetsRef.current = listDatasets;
  const listTablesRef = useRef(listTables);
  listTablesRef.current = listTables;
  function refreshDatasets() {
    setLoadingDatasets(true);
    setDatasetError(null);
    listDatasetsRef
      .current()
      .then((r) => (r.ok ? setDatasets(r.values) : setDatasetError(r.error)))
      .finally(() => setLoadingDatasets(false));
  }

  // Auto-load datasets when the source becomes listable, driven by autoLoadKey.
  // The first usable key loads immediately (snappy: a saved destination on
  // mount, or the moment the create form's credentials complete); later changes
  // debounce so editing a pasted key doesn't spray requests. loadedKeyRef guards
  // against reloading a key we already fetched.
  const loadedKeyRef = useRef<string | null>(null);
  const autoLoadedOnceRef = useRef(false);
  useEffect(() => {
    const key = autoLoadKey?.trim() ?? "";
    if (!key || key === loadedKeyRef.current) return;
    const load = () => {
      loadedKeyRef.current = key;
      refreshDatasets();
    };
    if (!autoLoadedOnceRef.current) {
      autoLoadedOnceRef.current = true;
      load();
      return;
    }
    const timer = setTimeout(load, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoLoadKey]);

  // (Re)load tables whenever the chosen dataset changes.
  useEffect(() => {
    const ds = dataset.trim();
    if (!ds) {
      setTables([]);
      setTableError(null);
      return;
    }
    let active = true;
    setLoadingTables(true);
    setTableError(null);
    listTablesRef
      .current(ds)
      .then((r) => {
        if (!active) return;
        if (r.ok) {
          setTables(r.values);
        } else {
          setTables([]);
          setTableError(r.error);
        }
      })
      .finally(() => active && setLoadingTables(false));
    return () => {
      active = false;
    };
  }, [dataset]);

  const isNewTable = table.trim().length > 0 && !tables.includes(table.trim());

  return (
    <div className="space-y-2">
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor={`${idPrefix}-dataset`}>Dataset</Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-[11px]"
            onClick={refreshDatasets}
            disabled={loadingDatasets}
          >
            {loadingDatasets ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {datasets.length ? "Refresh" : "Load datasets"}
          </Button>
        </div>
        <Combobox
          id={`${idPrefix}-dataset`}
          value={dataset}
          onChange={(next) => {
            onDatasetChange(next);
            onTableChange("");
          }}
          options={datasets}
          placeholder={loadingDatasets ? "Loading datasets…" : "Pick a dataset"}
          searchPlaceholder="Search datasets…"
          emptyText={
            datasets.length
              ? "No matching dataset."
              : "No datasets loaded — use Load datasets, or create them in BigQuery."
          }
          loading={loadingDatasets}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-table`}>Table</Label>
        <Combobox
          id={`${idPrefix}-table`}
          value={table}
          onChange={onTableChange}
          options={tables}
          allowCustom
          disabled={!dataset.trim()}
          placeholder={
            !dataset.trim()
              ? "Pick a dataset first"
              : loadingTables
                ? "Loading tables…"
                : "Pick or name a table"
          }
          searchPlaceholder="Search or name a table…"
          emptyText="Type a name to create a new table."
          createLabel={(v) => (
            <>
              Create table “<span className="font-mono">{v}</span>”
            </>
          )}
          loading={loadingTables}
        />
        {tableError ? (
          <p className="text-xs text-destructive">Couldn&apos;t list tables: {tableError}</p>
        ) : null}
      </div>

      {datasetError ? (
        <p className="text-xs text-destructive">Couldn&apos;t list datasets: {datasetError}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Datasets are existing only — create new ones in BigQuery.
          {isNewTable ? " New table — Axel creates it on the first delivery." : " A new table name is created on the first delivery."}
        </p>
      )}
    </div>
  );
}
