/**
 * Privacy boundaries for customer-derived text and connector diagnostics.
 * AI excerpts use text masking; durable and external diagnostics use fixed
 * operational codes because pattern matching cannot prove that arbitrary
 * text contains no webhook values.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 8+ digit runs (optionally space/hyphen grouped) — cards, SSNs, phone, account
// and routing numbers. Anchored on a digit at each end so short IDs are kept.
const LONG_DIGITS_RE = /\b\d(?:[\d -]{6,})\d\b/g;
const SENSITIVE_RESPONSE_FIELDS = new Set([
  "body",
  "body_excerpt",
  "data_array",
  "document",
  "http_body",
  "payload",
  "raw",
  "raw_body",
  "request_body",
  "response_body",
]);
const SECRET_RESPONSE_FIELD_RE =
  /(?:authorization|cookie|credential|password|secret|signature|token|api[_-]?key)/i;
const MAX_RESPONSE_DEPTH = 8;
const MAX_RESPONSE_KEYS = 64;
const MAX_RESPONSE_ARRAY_ITEMS = 32;

/** Mask emails and long digit sequences in arbitrary text. */
export function maskPiiInText(input: string): string {
  return input.replace(EMAIL_RE, "[EMAIL]").replace(LONG_DIGITS_RE, "[NUM]");
}

/**
 * Remove payload-bearing fields and value echoes before a connector outcome is
 * persisted to ClickHouse, dead letters, notifications, or Sentry-adjacent
 * diagnostics. Downstream HTTP/API errors are attacker-controlled and can
 * simply echo the submitted webhook body; retaining those excerpts creates a
 * second copy outside the raw-payload retention boundary.
 */
export function sanitizeConnectorResponseForStorage(value: unknown): unknown {
  return sanitizeResponseValue(value, 0);
}

/**
 * Project one connector diagnostic to a fixed operational code before it
 * reaches a database, log, notification, email, or telemetry provider.
 * Connector and receiver errors are attacker-controlled and can echo any
 * submitted value, so no free-form substring is retained.
 */
export function sanitizeConnectorDiagnosticForStorage(
  input: unknown,
  maxLength = 500,
): string {
  const text = typeof input === "string" ? input : String(input ?? "");
  const limit = Number.isFinite(maxLength)
    ? Math.max(0, Math.min(4000, Math.floor(maxLength)))
    : 500;
  return connectorDiagnosticCode(text).slice(0, limit);
}

const FIXED_DIAGNOSTIC_CODES = new Set([
  "bigquery_schema_mismatch",
  "bigquery_row_rejected",
  "authorization_failed",
  "circuit_breaker_open",
  "connection_failed",
  "constraint_violation",
  "databricks_response_too_large",
  "delivery_failed",
  "destination_not_found",
  "invalid_message",
  "invalid_payload",
  "invalid_signature",
  "not_found",
  "operation_failed",
  "operation_timeout",
  "payload_too_large",
  "queue_overloaded",
  "rate_limited",
  "replay_payload_key_mismatch",
  "route_not_found",
  "source_not_found",
  "ssrf_blocked",
]);

function connectorDiagnosticCode(text: string): string {
  const normalized = text.trim().toLowerCase();
  if (FIXED_DIAGNOSTIC_CODES.has(normalized)) return normalized;

  const status = /\b(?:http\s+|[a-z0-9_-]+_)([1-5][0-9]{2})\b/iu.exec(text)?.[1]
    ?? /\b(?:query failed|rejected)\s*\(([1-5][0-9]{2})\)/iu.exec(text)?.[1];
  if (status === "401" || status === "403") return "authorization_failed";
  if (status === "404") return "not_found";
  if (status === "408" || status === "504") return "operation_timeout";
  if (status === "413") return "payload_too_large";
  if (status === "429") return "rate_limited";
  if (status) return `http_error_${status}`;

  if (/\b(?:10250|queue is overloaded|queue overload)\b/iu.test(text)) {
    return "queue_overloaded";
  }
  if (/\b(?:breaker_open|circuit breaker)\b/iu.test(text)) {
    return "circuit_breaker_open";
  }
  if (/\b(?:ssrf|unsafe endpoint|private address|loopback)\b/iu.test(text)) {
    return "ssrf_blocked";
  }
  if (/\b(?:timed? out|timeout|aborterror)\b/iu.test(text)) {
    return "operation_timeout";
  }
  if (/\b(?:econn|connection (?:ended|refused|reset|terminated)|socket hang up)\b/iu.test(text)) {
    return "connection_failed";
  }
  if (/\b(?:duplicate key|unique constraint|constraint violation)\b/iu.test(text)) {
    return "constraint_violation";
  }
  if (/\b(?:unauthorized|forbidden|authentication|authorization)\b/iu.test(text)) {
    return "authorization_failed";
  }
  if (/\b(?:not found|missing object)\b/iu.test(text)) return "not_found";
  if (/\b(?:invalid json|invalid payload|malformed payload)\b/iu.test(text)) {
    return "invalid_payload";
  }
  return "operation_failed";
}

function sanitizeResponseValue(value: unknown, depth: number): unknown {
  if (depth > MAX_RESPONSE_DEPTH) return "[TRUNCATED]";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return sanitizeConnectorDiagnosticForStorage(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_RESPONSE_ARRAY_ITEMS)
      .map((item) => sanitizeResponseValue(item, depth + 1));
  }
  if (typeof value !== "object") return String(value);

  const sanitized: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)
    .slice(0, MAX_RESPONSE_KEYS)) {
    const normalized = key.trim().toLowerCase();
    if (SENSITIVE_RESPONSE_FIELDS.has(normalized)) continue;
    if (SECRET_RESPONSE_FIELD_RE.test(normalized)) {
      sanitized[key] = "[REDACTED]";
      continue;
    }
    sanitized[key] = sanitizeResponseValue(child, depth + 1);
  }
  return sanitized;
}
