"use client";

import { PostgresPicker } from "./PostgresPicker";
import { MongoPicker } from "./MongoPicker";
import { DatabricksSqlPicker } from "./DatabricksSqlPicker";
import { BigQueryPicker } from "./BigQueryPicker";
import { DatabricksVolumePicker } from "./DatabricksVolumePicker";
import { ObjectStorePicker } from "./ObjectStorePicker";

// Shared by the pipeline canvas's NodeInspector.
export { BigQueryCompatPanel, BigQueryNodeCompat } from "./BigQueryCompat";

/**
 * Per-destination binding picker rendered next to each checked
 * destination in the route create/edit form. The binding shape is
 * destination-type-specific and the picker writes a JSON blob to a
 * hidden input named `binding:<destination_id>` which the server
 * action reads on submit.
 *
 * For "container" types (postgres / mongo / databricks_sql / bigquery) the
 * picker fetches the live list of tables/collections on mount and
 * lets the user pick one or create a new one inline. For "prefix"
 * types (s3 / r2 / databricks_volume) the picker is a small set of
 * text inputs for the per-route slice.
 *
 * Each per-type picker is a small binding-shape adapter over the shared
 * useTargetList / useTargetPicker hooks and the TargetPickerShell /
 * ExistingTargetSelect / CreateTargetRow presentational pieces.
 */

interface Props {
  destinationId: string;
  destinationType: string;
  destinationName: string;
  /** Prefill values when editing an existing route. Shape is destination-type-specific. */
  initialBinding?: Record<string, unknown> | null;
  /** Route source id — enables the BigQuery pre-flight schema compatibility check. */
  sourceId?: string;
}

export function DestinationBindingPicker({
  destinationId,
  destinationType,
  destinationName,
  initialBinding,
  sourceId,
}: Props) {
  if (destinationType === "postgres") {
    return (
      <PostgresPicker
        destinationId={destinationId}
        destinationName={destinationName}
        initialBinding={initialBinding}
      />
    );
  }
  if (destinationType === "mongodb") {
    return (
      <MongoPicker
        destinationId={destinationId}
        destinationName={destinationName}
        initialBinding={initialBinding}
      />
    );
  }
  if (destinationType === "databricks_sql") {
    return (
      <DatabricksSqlPicker
        destinationId={destinationId}
        destinationName={destinationName}
        initialBinding={initialBinding}
      />
    );
  }
  if (destinationType === "bigquery") {
    return (
      <BigQueryPicker
        destinationId={destinationId}
        destinationName={destinationName}
        initialBinding={initialBinding}
        sourceId={sourceId}
      />
    );
  }
  if (destinationType === "databricks_volume") {
    return (
      <DatabricksVolumePicker
        destinationId={destinationId}
        destinationName={destinationName}
        initialBinding={initialBinding}
      />
    );
  }
  if (destinationType === "s3" || destinationType === "r2") {
    return (
      <ObjectStorePicker
        destinationId={destinationId}
        destinationName={destinationName}
        destinationType={destinationType}
        initialBinding={initialBinding}
      />
    );
  }
  // http / webhook: no per-route target needed — URL is the destination. Render a
  // confirmation panel rather than null so the empty slot doesn't read as a failure.
  return (
    <div className="rounded-md border border-input bg-muted/30 p-2.5 text-xs text-muted-foreground">
      {destinationName} — events are POSTed to the configured receiver URL. No per-route
      target needed.
    </div>
  );
}
