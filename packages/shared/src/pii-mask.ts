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
