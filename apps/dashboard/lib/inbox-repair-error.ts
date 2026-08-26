export function humanRepairError(message: string): string {
  if (message === "repair_fingerprint_muted") {
    return "This fingerprint is muted. Unmute it before applying the fix.";
  }
  if (message === "repair_route_not_found") return "This route no longer exists.";
  if (message === "repair_destination_detached") {
    return "This destination is no longer attached to the route.";
  }
  if (message === "repair_destination_binding_changed") {
    return "The route's BigQuery table changed while the fix was running. Refresh before replaying.";
  }
  if (message === "repair_destination_not_in_pipeline") {
    return "Axel could not find this destination in the current route pipeline.";
  }
  if (/bigquery\.jobs\.create/i.test(message)) {
    return "The destination service account needs BigQuery Job User (bigquery.jobs.create) on its Google Cloud project before Axel can change this column.";
  }
  if (/bigquery\.tables\.(?:update|updateData)|permission.*table/i.test(message)) {
    return "The destination service account needs BigQuery Data Editor access to change this table schema.";
  }
  if (
    /streaming buffer|streams attached|streaming.*(?:active|in use|attached)|currently streaming/i.test(
      message,
    )
  ) {
    return "BigQuery has an active streaming buffer and will not change this type yet. Pause deliveries to this table, wait for the buffer to clear (usually up to 5 hours), then run Fix data again.";
  }
  if (/bigquery_schema_change_incomplete/.test(message)) {
    return "BigQuery is still applying the schema change. Wait a moment, refresh, and run Fix data again; Axel will detect if FLOAT64 is already in place.";
  }
  if (/bigquery_schema_change_not_visible/.test(message)) {
    return "BigQuery accepted the request, but the FLOAT64 schema is not visible yet. Wait a moment, refresh, and run Fix data again.";
  }
  if (
    /bigquery_schema_(?:required_nested_field|repeated_ancestor|repeated_field|non_record_ancestor|empty_record|type_unsupported)/.test(
      message,
    )
  ) {
    return "Axel cannot safely rewrite this complex nested schema automatically. Use the route conversion or update the table in BigQuery.";
  }
  if (/bigquery_schema_type_changed/.test(message)) {
    return "The destination column changed since this failure was recorded. Refresh the Inbox so Axel can inspect the current type.";
  }
  if (/graph_too_many_nodes/.test(message)) {
    return "This route is already at its pipeline-step limit. Remove an unused step first.";
  }
  if (/identifier_rejected/.test(message)) return "The destination table configuration is invalid.";
  return message.slice(0, 300) || "Could not apply this fix.";
}
