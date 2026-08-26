/**
 * Audit-Sev1 — RFC 7230 header validation, shared across the
 * HTTP and signed-webhook connectors so the hardening can't drift
 * apart. Used to reject:
 *   - header names outside the RFC 7230 token grammar
 *   - hop-by-hop / routing-affecting names (Host, Content-Length,
 *     Transfer-Encoding, etc.) that enable directed-SSRF or
 *     request smuggling
 *   - header values containing CR / LF / NUL
 */

const FORBIDDEN_HEADER_NAMES = new Set<string>([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "upgrade",
  "expect",
]);

export function isSafeHeaderName(name: string): boolean {
  if (!/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(name)) return false;
  if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) return false;
  return true;
}

export function isSafeHeaderValue(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/**
 * Filter a header map down to the entries that pass both checks.
 * Drops unsafe entries silently — callers may pair with their own
 * logging to surface the drop to operators.
 */
export function filterSafeHeaders(input: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    if (isSafeHeaderName(k) && isSafeHeaderValue(v)) out[k] = v;
  }
  return out;
}
