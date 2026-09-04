const SAFE_DESTINATION_TYPES = new Set([
  "bigquery",
  "databricks_sql",
  "databricks_volume",
  "http",
  "mongodb",
  "postgres",
  "r2",
  "s3",
  "webhook",
]);

const SAFE_ERROR_CODES = new Set([
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
  "idempotency_claim_in_flight",
  "jwt_sign_failed",
  "mode_conflict",
  "native_delivery_invalid_response",
  "native_delivery_unconfigured",
  "non_json_response",
  "schema_propagation_pending",
  "schema_repair_transient",
  "spill_hydrate_failed",
  "spill_object_missing",
  "token_endpoint_missing_access_token",
  "token_endpoint_returned_non_json",
  "token_endpoint_unreachable",
  "unknown_destination",
  "unsupported_type",
]);

const SAFE_SKIP_REASONS = new Set([
  "breaker_half_open_test_failed",
  "breaker_open_cooldown_active",
  "delivery_paused",
  "destination_disabled_manually",
  "half_open_probe_in_flight",
  "half_open_probe_timed_out",
  "retry_after_window_active",
]);

const SAFE_SKIPPED_BY = new Set(["circuit_breaker", "delivery_controls"]);

/** Collapse connector/provider-controlled text into a stable storage code. */
export function deliveryAttemptErrorCode(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  if (SAFE_ERROR_CODES.has(normalized)) return normalized;
  if (/^(?:delivery_service|destination_http|native_delivery)_\d{3}$/.test(normalized)) {
    return normalized;
  }
  if (normalized.startsWith("ssrf_blocked")) return "ssrf_blocked";
  if (normalized.includes("not configured in this runtime")) return "connector_unconfigured";
  return "delivery_failed";
}

/**
 * Project an attempt response onto fields required for health/usage UI. Raw
 * provider bodies, connector exceptions, object keys, schema/table names, and
 * other string values never enter analytics storage.
 */
export function sanitizeDeliveryAttemptResponseForStorage(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  if (
    typeof input.destination_type === "string" &&
    SAFE_DESTINATION_TYPES.has(input.destination_type)
  ) {
    out.destination_type = input.destination_type;
  }

  const httpStatus = input.http_status ?? input.status;
  if (
    typeof httpStatus === "number" &&
    Number.isInteger(httpStatus) &&
    httpStatus >= 100 &&
    httpStatus <= 599
  ) {
    out.http_status = httpStatus;
  }
  if (
    typeof input.native_http_status === "number" &&
    Number.isInteger(input.native_http_status) &&
    input.native_http_status >= 100 &&
    input.native_http_status <= 599
  ) {
    out.native_http_status = input.native_http_status;
  }
  if (
    typeof input.retry_after_seconds === "number" &&
    Number.isFinite(input.retry_after_seconds) &&
    input.retry_after_seconds >= 0
  ) {
    out.retry_after_seconds = Math.min(86_400, input.retry_after_seconds);
  }
  for (const key of ["signed", "forwarded_to_native"] as const) {
    if (typeof input[key] === "boolean") out[key] = input[key];
  }

  const error = deliveryAttemptErrorCode(input.error);
  if (error) out.error = error;
  if (typeof input.reason === "string" && SAFE_SKIP_REASONS.has(input.reason)) {
    out.reason = input.reason;
  }
  if (typeof input.skipped === "string" && SAFE_SKIP_REASONS.has(input.skipped)) {
    out.skipped = input.skipped;
  }
  if (typeof input.skipped_by === "string" && SAFE_SKIPPED_BY.has(input.skipped_by)) {
    out.skipped_by = input.skipped_by;
  }

  return out;
}
