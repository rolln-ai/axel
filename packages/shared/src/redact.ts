/**
 * Per-source PII redaction applied at ingest, BEFORE the raw body is written
 * to R2. The audit flagged that full payloads persist verbatim, with no way to
 * keep PII out of durable storage. A source can configure `redact_paths`
 * (dot-paths, with `[]` to descend into arrays) and the ingest worker masks
 * those leaves with "[REDACTED]" before the durable write — so the PII never
 * lands in R2 and is therefore never delivered downstream either.
 *
 * Path syntax:
 *   "user.email"          -> masks payload.user.email
 *   "customer.cards[].cvv" -> masks .cvv on every element of customer.cards
 *   "tags[]"              -> masks every element of tags
 *
 * Non-JSON bodies are returned unchanged (we can't safely redact an opaque
 * blob). Missing paths are no-ops. Pure — runs in Workers, Node, and tests.
 */

const REDACTED = "[REDACTED]";

export function redactJsonPayload(bytes: Uint8Array, paths: readonly string[]): Uint8Array {
  if (!paths || paths.length === 0) return bytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return bytes; // not JSON — leave untouched
  }
  if (parsed === null || typeof parsed !== "object") return bytes;
  let changed = false;
  for (const path of paths) {
    const segments = path.split(".").map((s) => s.trim()).filter((s) => s.length > 0);
    if (segments.length > 0 && redactAt(parsed, segments)) changed = true;
  }
  if (!changed) return bytes;
  return new TextEncoder().encode(JSON.stringify(parsed));
}

function redactAt(node: unknown, segments: readonly string[]): boolean {
  if (node === null || typeof node !== "object" || segments.length === 0) return false;
  const head = segments[0]!;
  const rest = segments.slice(1);
  const isArray = head.endsWith("[]");
  const key = isArray ? head.slice(0, -2) : head;

  if (Array.isArray(node)) {
    // A path segment applied to an array element-wise was already handled by
    // the parent's `[]`; reaching here with a bare array means the path shape
    // didn't match. Ignore.
    return false;
  }
  const obj = node as Record<string, unknown>;
  if (!(key in obj)) return false;

  if (isArray) {
    const arr = obj[key];
    if (!Array.isArray(arr)) return false;
    if (rest.length === 0) {
      obj[key] = arr.map(() => REDACTED);
      return true;
    }
    let any = false;
    for (const element of arr) {
      if (redactAt(element, rest)) any = true;
    }
    return any;
  }

  if (rest.length === 0) {
    obj[key] = REDACTED;
    return true;
  }
  return redactAt(obj[key], rest);
}
