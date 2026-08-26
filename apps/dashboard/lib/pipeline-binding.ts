/**
 * Pure helpers for the New Source wizard's per-route destination binding.
 *
 * A brand-new destination created in the wizard has no id client-side, so the
 * modal submits the target name in `new_destination_target` and the server
 * shapes it here — mirroring the per-type binding blobs DestinationBindingPicker
 * writes for the existing-destination path. Without a binding a table-shaped
 * destination has nowhere to land events and every delivery fails.
 *
 * Kept out of `actions.ts` (a "use server" module, which can only export async
 * functions) so the shapes are unit-testable and importable by the dialog.
 */
import type { BigQueryBinding } from "@axel/shared";
import { formValue } from "./form";

/** Destination types that can't deliver without a per-route binding. */
export const PIPELINE_BINDING_REQUIRED = new Set([
  "postgres",
  "mongodb",
  "databricks_sql",
  "databricks_volume",
  "bigquery",
]);

export type BigQueryWriteMode = NonNullable<BigQueryBinding["mode"]>;
export const BIGQUERY_NESTED_MIGRATION_KEY = "_axel_nested_records_migration";
const VALID_BIGQUERY_TABLE = /^[A-Za-z0-9_-]{1,1024}$/;
const VALID_BIGQUERY_DATASET = /^[A-Za-z0-9_]{1,1024}$/;

export interface NormalizedBigQueryTarget {
  dataset: string;
  table: string;
}

type PreparedBigQueryBinding =
  | { binding: Record<string, unknown> }
  | {
      error:
        | "invalid_bigquery_table"
        | "invalid_bigquery_dataset"
        | "missing_bigquery_dataset";
    };

export function normalizeBigQueryTableName(value: unknown): string | null {
  const table = typeof value === "string" ? value.trim() : "";
  return VALID_BIGQUERY_TABLE.test(table) ? table : null;
}

export function normalizeBigQueryDatasetName(value: unknown): string | null {
  const dataset = typeof value === "string" ? value.trim() : "";
  return VALID_BIGQUERY_DATASET.test(dataset) ? dataset : null;
}

/**
 * Parse the route picker's required `dataset.table` target.
 */
export function normalizeBigQueryTarget(value: unknown): NormalizedBigQueryTarget | null {
  const target = typeof value === "string" ? value.trim() : "";
  const parts = target.split(".");
  if (parts.length !== 2) return null;
  const dataset = normalizeBigQueryDatasetName(parts[0]);
  const table = normalizeBigQueryTableName(parts[1]);
  return dataset && table ? { dataset, table } : null;
}

export function formatBigQueryTarget(binding?: Record<string, unknown> | null): string {
  if (!binding) return "";
  const table = normalizeBigQueryTableName(binding.table);
  if (!table) return typeof binding.table === "string" ? binding.table : "";
  const dataset = normalizeBigQueryDatasetName(binding.dataset);
  return dataset ? `${dataset}.${table}` : table;
}

/** Normalize a submitted binding and discard control-plane metadata from the client. */
export function prepareBigQueryBindingForCreate(
  submittedBinding: object,
): PreparedBigQueryBinding {
  const submitted = submittedBinding as Record<string, unknown>;
  const binding = Object.fromEntries(
    Object.entries(submitted).filter(([key]) => key !== BIGQUERY_NESTED_MIGRATION_KEY),
  );
  const target = normalizeBigQueryTarget(binding.table);
  const table = target?.table ?? normalizeBigQueryTableName(binding.table);
  if (!table) return { error: "invalid_bigquery_table" };

  let dataset = target?.dataset;
  if (binding.dataset !== undefined) {
    const explicitDataset = normalizeBigQueryDatasetName(binding.dataset);
    if (!explicitDataset) return { error: "invalid_bigquery_dataset" };
    if (dataset && dataset !== explicitDataset) return { error: "invalid_bigquery_dataset" };
    dataset = explicitDataset;
  }
  if (!dataset) return { error: "missing_bigquery_dataset" };

  const normalized: Record<string, unknown> = { ...binding, dataset, table };
  return { binding: normalized };
}

/**
 * Pick the route editor's initial BigQuery mode without silently migrating an
 * existing binding. A missing binding means brand-new wiring and uses the new
 * nested default; a saved binding with no mode predates mode selection and
 * must remain `json_column` for backwards compatibility.
 */
export function bigQueryModeForBinding(
  binding?: object | null,
): BigQueryWriteMode {
  const mode = binding && "mode" in binding ? binding.mode : undefined;
  if (
    mode === "nested_records" ||
    mode === "json_column" ||
    mode === "columns" ||
    mode === "typed_records"
  ) {
    return mode;
  }
  // New wiring defaults to typed_records (preserve source types); a saved
  // binding with no mode predates mode selection and stays json_column.
  return binding == null ? "typed_records" : "json_column";
}

export function prepareBigQueryBindingForEdit(
  nextBinding: object,
  previousBinding: unknown,
):
  | { binding: Record<string, unknown> }
  | {
      error:
        | "invalid_bigquery_table"
        | "invalid_bigquery_dataset"
        | "missing_bigquery_dataset"
        | "nested_requires_new_table";
    } {
  const prepared = prepareBigQueryBindingForCreate(nextBinding);
  if ("error" in prepared) return prepared;
  const next = prepared.binding;
  if (!previousBinding || typeof previousBinding !== "object" || Array.isArray(previousBinding)) {
    return { binding: next };
  }
  const previous = previousBinding as Record<string, unknown>;
  const previousTable = typeof previous.table === "string" ? previous.table.trim() : "";
  const nextTable = next.table as string;
  const previousDataset = normalizeBigQueryDatasetName(previous.dataset) ?? "";
  const nextDataset = normalizeBigQueryDatasetName(next.dataset) ?? "";
  const previousMode = bigQueryModeForBinding(previous);
  const nextMode = bigQueryModeForBinding(next);

  if (
    nextMode === "nested_records" &&
    previousMode !== "nested_records" &&
    nextTable === previousTable &&
    nextDataset === previousDataset
  ) {
    return { error: "nested_requires_new_table" };
  }

  const metadata = previous[BIGQUERY_NESTED_MIGRATION_KEY];
  if (
    nextMode === previousMode &&
    nextTable === previousTable &&
    nextDataset === previousDataset &&
    metadata &&
    typeof metadata === "object" &&
    !Array.isArray(metadata)
  ) {
    return {
      binding: {
        ...next,
        [BIGQUERY_NESTED_MIGRATION_KEY]: metadata,
      },
    };
  }
  return { binding: next };
}

/**
 * Shape the per-route binding for a newly-created destination from its target
 * name. Returns null when there's nothing to bind (no target, or a URL-shaped
 * destination like webhook/http). Refinable later on the route's Destinations
 * tab.
 *
 * Postgres defaults to `dotted_columns`: the wizard creates a minimal table
 * shell (id + received_at) and the connector auto-creates one dot-notation
 * column per leaf key on first delivery — so events land as queryable columns,
 * not one opaque JSONB blob. (The old jsonb_blob default wrote into a "payload"
 * column the shell never had, which 100%-failed every fresh destination.)
 *
 * BigQuery and Databricks SQL default to typed shapes (`typed_records` /
 * `typed_columns`): new tables get warehouse-native, type-preserving columns
 * (numbers → INT64/BIGINT, booleans → BOOL/BOOLEAN) that grow additively as new
 * payload keys arrive, rather than STRING-normalizing every value.
 */
export function pipelineBindingForNewDestination(
  type: string,
  target: string,
): Record<string, unknown> | null {
  const t = target.trim();
  if (!t) return null;
  switch (type) {
    case "postgres":
      return { table: t, mode: "dotted_columns" };
    case "databricks_sql":
      return { table: t, mode: "typed_columns" };
    case "bigquery": {
      const target = normalizeBigQueryTarget(t);
      return target ? { ...target, mode: "typed_records" } : { table: t, mode: "typed_records" };
    }
    case "mongodb":
      return { collection: t };
    case "databricks_volume":
      return { volume: t };
    case "s3":
    case "r2":
      return { key_prefix: t };
    default:
      return null;
  }
}

/**
 * Pull a per-destination binding out of a route create/edit form.
 * Form encodes bindings as `binding:<destination_id>` carrying a JSON
 * blob. Missing / empty / invalid JSON returns null so the destination
 * falls back to its config-level defaults.
 *
 * The shape is destination-type-dependent; we don't validate here —
 * the connector's resolver does the type check at delivery time.
 */
export function parseBindingFromForm(formData: FormData, destinationId: string): unknown {
  const raw = formValue(formData, `binding:${destinationId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}
