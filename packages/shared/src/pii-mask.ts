/**
 * Value-level PII masking for free text that may echo customer data.
 *
 * Two surfaces use this:
 *   - Database-connector error strings before they land in `dead_letters.message`
 *     (which flows into notification rows and Resend alert emails). A Postgres
 *     driver error like `Key (email)=(alice@x.com) already exists` or
 *     `invalid input syntax for type integer: "4111 1111 1111 1111"` echoes the
 *     offending value verbatim.
 *   - Payload excerpts sent to the OpenRouter LLM for failure/inference explain.
 *
 * This is best-effort masking of the obvious high-risk shapes (emails, long
 * digit runs, Postgres DETAIL value echoes), not a guarantee — it keeps the
 * error class/structure intact for debugging while dropping the raw values.
 */

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// 8+ digit runs (optionally space/hyphen grouped) — cards, SSNs, phone, account
// and routing numbers. Anchored on a digit at each end so short IDs are kept.
const LONG_DIGITS_RE = /\b\d(?:[\d -]{6,})\d\b/g;
const AUTH_VALUE_RE = /\b(Bearer|Basic)\s+[^\s,;]+/gi;
const TOKEN_VALUE_RE = /\b(?:axe_pat|whsec|sk|rk|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/gi;
const URL_QUERY_VALUE_RE = /([?&][A-Za-z0-9_.~-]{1,128}=)[^&#\s]*/g;
const URI_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi;
const HTTP_DIAGNOSTIC_DETAIL_RE = /(\b(?:HTTP\s+\d{3}|[A-Za-z0-9_-]+_http_\d{3}|delivery_service_\d{3})\s*:\s*)[\s\S]*/i;
const SECRET_ASSIGNMENT_RE = /(\b(?:authorization|client[_ -]?secret|cookie|credential|password|passwd|private[_ -]?key|refresh[_ -]?token|secret|secret[_ -]?access[_ -]?key|signature|token|api[_ -]?key|access[_ -]?key)\b\s*(?:=|:|\bis\b)\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
const PAYLOAD_ASSIGNMENT_RE = /(\b(?:body|data|document|event|input|payload|raw|record|response[_ -]?body|row|value)\b\s*(?:=|:)\s*)(?:\{[^\r\n]{0,2000}\}|\[[^\r\n]{0,2000}\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi;
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/gi;
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
 * Scrub a database-connector error string before persisting it. Redacts the
 * Postgres DETAIL value echo (`Key (col)=(value)`), then masks residual
 * emails/long-digit runs. Deliberately narrow — it must not mangle structured
 * (JSON) error diagnostics — so it keeps constraint names, type names, and the
 * error class, and leaves free-text names it can't pattern-match (an accepted
 * residual; the DETAIL echo is the common unique-violation case).
 */
export function scrubConnectorError(message: string): string {
  // Postgres DETAIL: `Key (col)=(value) already exists.`
  return maskPiiInText(message.replace(/=\([^)]*\)/g, "=([REDACTED])"));
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
 * Scrub one free-text connector diagnostic before it reaches a database, log,
 * notification, or email. Connector and receiver errors are untrusted text.
 * They can echo a submitted row, URL credentials, or a secret-bearing header.
 */
export function sanitizeConnectorDiagnosticForStorage(
  input: unknown,
  maxLength = 500,
): string {
  const text = typeof input === "string" ? input : String(input ?? "");
  const limit = Number.isFinite(maxLength)
    ? Math.max(0, Math.min(4000, Math.floor(maxLength)))
    : 500;
  const withoutReceiverDetail = text.replace(
    HTTP_DIAGNOSTIC_DETAIL_RE,
    "$1[REDACTED]",
  );
  return scrubConnectorError(withoutReceiverDetail.replace(URI_USERINFO_RE, "$1[REDACTED]@"))
    .replace(PRIVATE_KEY_RE, "[REDACTED PRIVATE KEY]")
    .replace(AUTH_VALUE_RE, "$1 [REDACTED]")
    .replace(TOKEN_VALUE_RE, "[REDACTED]")
    .replace(URL_QUERY_VALUE_RE, "$1[REDACTED]")
    .replace(SECRET_ASSIGNMENT_RE, "$1[REDACTED]")
    .replace(PAYLOAD_ASSIGNMENT_RE, "$1[REDACTED]")
    .replace(/"(?:\\.|[^"\\])*"/g, '"[REDACTED]"')
    .replace(/'(?:\\.|[^'\\])*'/g, "'[REDACTED]'")
    .slice(0, limit);
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
