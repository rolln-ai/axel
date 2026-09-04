/** Stable connector error codes that are safe to show to workspace users. */
const PUBLIC_DELIVERY_ERROR_CODES = new Set([
  "already_delivered",
  "bigquery_delivery_failed",
  "bigquery_delivery_transient",
  "bigquery_forbidden",
  "bigquery_http_error",
  "bigquery_not_found",
  "bigquery_quota_limited",
  "bigquery_transient_http",
  "bigquery_unauthorized",
  "databricks_response_too_large",
  "databricks_statement_failed",
  "databricks_volume_failed",
  "databricks_volume_transport_failed",
  "delivery_overloaded",
  "jwt_sign_failed",
  "mode_conflict",
  "non_json_response",
  "schema_propagation_pending",
  "schema_repair_transient",
  "spill_hydrate_failed",
  "spill_object_missing",
  "token_endpoint_missing_access_token",
  "token_endpoint_returned_non_json",
  "token_endpoint_unreachable",
]);

/** Collapse untrusted connector/provider text into a stable display code. */
export function publicDeliveryErrorCode(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return PUBLIC_DELIVERY_ERROR_CODES.has(normalized) ? normalized : "delivery_failed";
}
