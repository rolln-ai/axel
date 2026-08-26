/**
 * Return-path plumbing for the auth gate.
 *
 * When a signed-out (or session-expired) user hits a protected page, the
 * proxy stamps the requested path into RETURN_TO_HEADER, requireSession()
 * forwards it to /login?returnTo=..., and signIn() sends the user back there
 * after authenticating instead of dumping everyone on /dashboard.
 *
 * `safeReturnTo` is the single validator both ends use. It only ever accepts
 * a same-origin RELATIVE path: anything that a browser could interpret as an
 * absolute or protocol-relative URL (open-redirect material) returns null and
 * the caller falls back to the default destination.
 *
 * Pure module (no "server-only", no Node APIs) so the edge proxy can import
 * it and the truth table stays unit-testable.
 */

export const RETURN_TO_HEADER = "x-axel-pathname";

const MAX_RETURN_TO_LENGTH = 2048;

/**
 * Auth surfaces never make sense as a post-login destination: returning to
 * /login would loop, and /reset|/verify links are single-use tokens. /welcome
 * is excluded because the login page already routes zero-workspace users
 * there itself.
 */
const BLOCKED_PATH_PREFIXES = ["/login", "/signup", "/forgot", "/reset", "/verify", "/welcome"];

/**
 * Validate an untrusted returnTo candidate down to a same-origin relative
 * path, or null.
 *
 * Rejects:
 *  - anything not starting with a single "/" (covers `https://evil.com`,
 *    `javascript:`, bare paths, empty),
 *  - protocol-relative `//evil.com`,
 *  - backslash variants like `/\evil.com` (browsers normalize `\` to `/`),
 *    and backslashes anywhere in the value,
 *  - whitespace/control characters (header-injection material),
 *  - auth pages and the bare root, where a round-trip adds nothing.
 */
export function safeReturnTo(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_RETURN_TO_LENGTH) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//")) return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally rejects control characters (header-injection defense)
  if (/[\\\s]|[\u0000-\u001f\u007f]/.test(raw)) return null;
  const pathOnly = raw.split(/[?#]/, 1)[0] ?? raw;
  if (pathOnly === "/") return null;
  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (pathOnly === prefix || pathOnly.startsWith(`${prefix}/`)) return null;
  }
  return raw;
}

/** The /login URL to bounce an unauthenticated request to, preserving the origin path when it validates. */
export function loginPathWithReturnTo(returnTo: string | null | undefined): string {
  const safe = safeReturnTo(returnTo);
  return safe ? `/login?returnTo=${encodeURIComponent(safe)}` : "/login";
}
