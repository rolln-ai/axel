"use client";

import * as React from "react";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  CREATABLE_DESTINATION_SCHEMAS,
  type DestinationSchema,
} from "../../../../../lib/destination-defaults";
import type { ActionState } from "../../../../../lib/action-data";
import {
  listBigQueryDatasetsAction,
  listBigQueryTablesAction,
} from "../../../../../lib/destination-binding-actions";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ConditionalDestField } from "../../../destinations/ConditionalDestField";
import { DestinationBindingPicker } from "../../../routes/DestinationBindingPicker";
import { NewDestinationTargetPicker } from "../../NewDestinationTargetPicker";
import { BigQueryDatasetTablePicker } from "@/components/bigquery-dataset-table-picker";
import {
  BINDING_REQUIRED_TYPES,
  bindingTargetHint,
  bindingTargetLabel,
  type DestinationMode,
  type ExistingDestination,
} from "../helpers";
import { ModeRadio } from "./shared";

/**
 * Step 2 — where events land: an existing destination (with inline binding
 * picker), a brand-new destination (schema-driven fields + target), or skip.
 * Rendered inside the wizard's single <form>; hidden (not unmounted) on other
 * steps so field state survives step transitions.
 */
export function DestinationStep({
  existingDestinations,
  destinationMode,
  onDestinationModeChange,
  pickedExistingDestId,
  onPickedExistingDestIdChange,
  newDestinationType,
  onNewDestinationTypeChange,
  selectedDestSchema,
  onDestFieldValuesChange,
  bqDataset,
  bqTable,
  onBqDatasetChange,
  onBqTableChange,
  bqCredentialsKey,
  readFormValue,
  formRef,
  destConnState,
  destConnAction,
  destConnPending,
}: {
  existingDestinations: ExistingDestination[];
  destinationMode: DestinationMode;
  onDestinationModeChange: (mode: DestinationMode) => void;
  pickedExistingDestId: string;
  onPickedExistingDestIdChange: (id: string) => void;
  newDestinationType: string;
  onNewDestinationTypeChange: (type: string) => void;
  selectedDestSchema: DestinationSchema | undefined;
  onDestFieldValuesChange: (values: Record<string, string>) => void;
  bqDataset: string;
  bqTable: string;
  onBqDatasetChange: (dataset: string) => void;
  onBqTableChange: (table: string) => void;
  bqCredentialsKey: string | null;
  readFormValue: (name: string) => string;
  formRef: RefObject<HTMLFormElement | null>;
  destConnState: ActionState;
  destConnAction: (payload: FormData) => void;
  destConnPending: boolean;
}) {
  return (
    <>
      <fieldset className="space-y-2">
        <legend id="dest-mode-legend" className="text-sm font-medium text-foreground">Where should events land?</legend>
        <div
          role="radiogroup"
          aria-labelledby="dest-mode-legend"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        >
          {existingDestinations.length > 0 ? (
            <ModeRadio
              label="Use existing destination"
              description="Attach the new source to a destination already in this workspace."
              selected={destinationMode === "existing"}
              onSelect={() => onDestinationModeChange("existing")}
            />
          ) : null}
          <ModeRadio
            label="Create new destination"
            description="Spin up a fresh destination as part of this flow."
            selected={destinationMode === "new"}
            onSelect={() => onDestinationModeChange("new")}
          />
          <ModeRadio
            label="Skip for now"
            description="Just capture events. Axel stores everything it receives — add a destination later and replay."
            selected={destinationMode === "skip"}
            onSelect={() => onDestinationModeChange("skip")}
          />
        </div>
      </fieldset>

      {destinationMode === "existing" && existingDestinations.length > 0 ? (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pipeline-existing-dest">Destination</Label>
            <Select
              name="existing_destination_id"
              value={pickedExistingDestId}
              onValueChange={onPickedExistingDestIdChange}
            >
              <SelectTrigger id="pipeline-existing-dest" className="h-auto w-full px-3 py-2.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {existingDestinations.map((dest) => (
                  <SelectItem key={dest.id} value={dest.id}>
                    <span>{dest.name}</span>
                    <span className="text-muted-foreground"> · {dest.type}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Container-shaped destinations (Postgres / BigQuery table,
              Mongo collection, Databricks Delta, S3/R2 prefix) need a
              binding before the first event can land. Show it
              inline here — operators previously had to create the
              route, then re-edit it on the Routes tab to pick the
              table/collection, which broke the "one-step pipeline"
              promise. DestinationBindingPicker returns null for
              types that don't need a binding (http/webhook), so
              rendering it unconditionally is safe. */}
          {pickedExistingDestId ? (() => {
            const picked = existingDestinations.find((d) => d.id === pickedExistingDestId);
            if (!picked) return null;
            return (
              <DestinationBindingPicker
                key={picked.id}
                destinationId={picked.id}
                destinationType={picked.type}
                destinationName={picked.name}
              />
            );
          })() : null}
        </div>
      ) : null}

      {destinationMode === "new" && selectedDestSchema ? (
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="pipeline-new-dest-type">Destination type</Label>
            <Select
              value={newDestinationType}
              onValueChange={(v) => onNewDestinationTypeChange(v)}
            >
              <SelectTrigger id="pipeline-new-dest-type" className="h-auto w-full px-3 py-2.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                {CREATABLE_DESTINATION_SCHEMAS.map((schema) => (
                  <SelectItem key={schema.type} value={schema.type}>
                    <span className="font-mono text-xs">{schema.glyph}</span>
                    <span>{schema.label}</span>
                  </SelectItem>
                ))}
                <SelectItem value="databricks_sql" disabled>
                  <span className="font-mono text-xs">D</span>
                  <span>Databricks SQL Warehouse — create on Destinations page first</span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{selectedDestSchema.blurb}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="pipeline-new-dest-name">Destination name</Label>
            <Input
              id="pipeline-new-dest-name"
              name="new_destination_name"
              // No `required` here: step-2 fields are validated by
              // continueToStep(3) before submission so the "Just
              // create source" path doesn't get blocked by browser
              // validation of a field the user is intentionally
              // skipping.
              minLength={2}
              maxLength={64}
              placeholder={`${selectedDestSchema.type}-prod`}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <DestinationFieldset
            key={selectedDestSchema.type}
            schema={selectedDestSchema}
            onValuesChange={onDestFieldValuesChange}
          />
          {/* Per-route binding for a NEW destination. We can't list live
              tables (the destination doesn't exist yet), so capture the
              name; the server shapes it. Without this, table-shaped
              destinations have nowhere to land events. */}
          {BINDING_REQUIRED_TYPES.has(newDestinationType) ? (
            newDestinationType === "postgres" || newDestinationType === "mongodb" ? (
              <NewDestinationTargetPicker destinationType={newDestinationType} formRef={formRef} />
            ) : newDestinationType === "bigquery" ? (
              <div className="space-y-1.5">
                {/* dataset + table combine into new_destination_target (dataset.table),
                    which the create action parses. Lists against the just-entered
                    service-account key via the form. */}
                <input
                  type="hidden"
                  name="new_destination_target"
                  value={
                    bqDataset.trim() && bqTable.trim()
                      ? `${bqDataset.trim()}.${bqTable.trim()}`
                      : ""
                  }
                />
                <BigQueryDatasetTablePicker
                  idPrefix="wizard-bq"
                  dataset={bqDataset}
                  table={bqTable}
                  onDatasetChange={onBqDatasetChange}
                  onTableChange={onBqTableChange}
                  autoLoadKey={bqCredentialsKey}
                  listDatasets={() =>
                    listBigQueryDatasetsAction({
                      projectId: readFormValue("dest_field_project_id"),
                      serviceAccountJson: readFormValue("dest_field_service_account_json"),
                    })
                  }
                  listTables={(d) =>
                    listBigQueryTablesAction({
                      projectId: readFormValue("dest_field_project_id"),
                      serviceAccountJson: readFormValue("dest_field_service_account_json"),
                      dataset: d,
                    })
                  }
                />
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label htmlFor="pipeline-new-dest-target">
                  {bindingTargetLabel(newDestinationType)}
                </Label>
                <Input
                  id="pipeline-new-dest-target"
                  name="new_destination_target"
                  placeholder={
                    newDestinationType === "databricks_volume"
                      ? "webhooks_landing"
                      : newDestinationType === "bigquery"
                        ? "analytics.events"
                        : "events"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono"
                  pattern={newDestinationType === "bigquery" ? "[A-Za-z0-9_]+\\.[A-Za-z0-9_-]+" : undefined}
                  maxLength={newDestinationType === "bigquery" ? 2049 : undefined}
                />
                <p className="text-xs text-muted-foreground">
                  {bindingTargetHint(newDestinationType)}
                </p>
                {newDestinationType === "databricks_volume" ? (
                  <p className="text-xs text-muted-foreground">
                    The volume must already exist in Unity Catalog — create it in the Catalog
                    Explorer before saving this destination. Point a Databricks Auto Loader
                    stream at the volume path to ingest these files into Delta.{" "}
                    <a
                      className="underline hover:text-foreground"
                      href="https://docs.databricks.com/en/ingestion/auto-loader/index.html"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Auto Loader docs
                    </a>
                  </p>
                ) : null}
              </div>
            )
          ) : null}
          {destConnState.error ? (
            <Alert variant="destructive">
              <AlertTitle>Connection failed</AlertTitle>
              <AlertDescription>
                <pre className="font-mono text-xs whitespace-pre-wrap break-all">
                  {destConnState.error}
                </pre>
              </AlertDescription>
            </Alert>
          ) : destConnState.notice ? (
            <Alert>
              <AlertDescription>{destConnState.notice}</AlertDescription>
            </Alert>
          ) : null}
          {/* Connectivity-only pre-flight (#A). NOT a form submit: React
              19 resets a form's uncontrolled fields after any action
              submitted through it completes, which previously wiped the
              destination name / connection string / target table the
              moment the user clicked Test. We instead snapshot the form's
              current values and dispatch the probe action directly, so
              none of those typed fields get cleared. */}
          {!["r2", "s3"].includes(newDestinationType) ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={destConnPending}
              className="w-full sm:w-auto"
              onClick={() => {
                if (!formRef.current) return;
                const fd = new FormData(formRef.current);
                React.startTransition(() => {
                  destConnAction(fd);
                });
              }}
            >
              {destConnPending ? "Testing…" : "Test connection"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function DestinationFieldset({
  schema,
  onValuesChange,
}: {
  schema: DestinationSchema;
  // Fires with the live field values (seeded defaults + edits) so the parent can
  // react to credentials — e.g. auto-load BigQuery datasets once the token lands.
  onValuesChange?: (values: Record<string, string>) => void;
}) {
  // Track the live value of every field so (1) `select` fields render as real
  // dropdowns instead of an invalid <input type="select"> text box, and
  // (2) conditional `showWhen` fields appear/disappear as their controlling
  // field changes. Seeded from each field's defaultValue. The parent remounts
  // this component (key={destination type}) when the type changes, so the
  // seed re-runs cleanly without stale keys.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of schema.fields) if (f.defaultValue != null) init[f.key] = f.defaultValue;
    return init;
  });
  // "Connect without certificate verification" — Postgres only. Controlled so
  // it survives the React-19 uncontrolled-field reset the wizard fights elsewhere.
  const [sslNoVerify, setSslNoVerify] = useState(false);

  // Surface live field values to the parent (kept in a ref so the effect doesn't
  // depend on the callback's identity — the parent passes a fresh closure each
  // render). Fires on mount with the seeded defaults, then on every edit.
  const onValuesChangeRef = useRef(onValuesChange);
  onValuesChangeRef.current = onValuesChange;
  useEffect(() => {
    onValuesChangeRef.current?.(values);
  }, [values]);

  // Some destination types take no per-destination credentials (e.g. R2 uses
  // Axel's shared managed bucket). Render an explanation instead of an
  // empty dashed box so the operator isn't left staring at a blank container.
  if (schema.fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {schema.emptyStateNote ??
          "No additional configuration needed for this destination type. The route binding is set per route."}
      </p>
    );
  }
  return (
    <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
      {/* Conditional fields (e.g. the HTTP auth credentials) only render —
          and therefore only submit — when their controlling field matches.
          An unrendered input contributes nothing to FormData, so the server
          never receives stale credentials for an auth mode the user didn't
          pick. The wizard variant keeps text inputs UNCONTROLLED and skips
          native `required` — see ConditionalDestField for the React-19 and
          "Just create source" rationale. */}
      {schema.fields.map((field) => (
        <ConditionalDestField
          key={field.key}
          field={field}
          type={schema.type}
          fieldValues={values}
          setFieldValue={(key, value) => setValues((s) => ({ ...s, [key]: value }))}
          variant="wizard"
          namePrefix="dest_field_"
          idPrefix="pipeline-dest-"
        />
      ))}
      {schema.type === "postgres" || schema.type === "mongodb" ? (
        <label htmlFor="pipeline-dest-ssl-no-verify" className="flex items-start gap-2.5 pt-1">
          <input
            id="pipeline-dest-ssl-no-verify"
            type="checkbox"
            name={
              schema.type === "postgres"
                ? "dest_field_pg_ssl_no_verify"
                : "dest_field_mongo_tls_no_verify"
            }
            value="true"
            checked={sslNoVerify}
            onChange={(e) => setSslNoVerify(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-foreground"
          />
          <span className="space-y-0.5">
            <span className="block text-sm font-medium">
              Connect without TLS certificate verification
            </span>
            <span className="block text-xs text-muted-foreground">
              Enable only for a database with a self-signed or private-CA certificate (e.g.{" "}
              {schema.type === "postgres" ? "Railway, Heroku Postgres" : "a self-hosted replica set"}).
              Stays encrypted, but skips certificate-chain verification — use it only when you trust
              the network path. Appends{" "}
              <code className="font-mono">
                {schema.type === "postgres" ? "sslmode=no-verify" : "tlsAllowInvalidCertificates=true"}
              </code>{" "}
              to the stored connection string.
            </span>
          </span>
        </label>
      ) : null}
    </div>
  );
}
