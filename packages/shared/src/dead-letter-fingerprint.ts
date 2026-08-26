/**
 * Dead-letter fingerprint (AXE-57).
 *
 * A stable, opaque hash of (route_id, reason, normalised message slug) that
 * collapses thousands of identical failures into one inbox group and is the
 * key the operator mutes against (`dead_letter_mutes.fingerprint`). It is
 * computed in app code — never the DB — so the formula can evolve without a
 * migration (see migration 0013). Every dead_letters writer stamps the column
 * with this exact function, and the dashboard recomputes it for the inbox view,
 * so the two MUST agree byte-for-byte.
 *
 * Pure Web-Crypto, like signature-verify.ts: the same code runs in the
 * Cloudflare Workers that write dead letters (delivery-edge, router-edge),
 * in Node (delivery-service, dashboard), and under Vitest with no shims.
 * crypto.subtle.digest hashes the UTF-8 bytes from TextEncoder, which is
 * byte-identical to node:crypto createHash('sha256').update(str) — so a mute
 * created from the old node:crypto formula keeps matching the new column.
 */

// Minimal Web-Platform global declarations — same rationale as
// signature-verify.ts: declare the smallest surface so downstream package
// compilations don't inherit the full DOM lib.
declare const crypto: {
  subtle: {
    digest(algorithm: "SHA-256", data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
  };
};
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/** Slug length fed into the hash. Longer messages share a fingerprint when
 * their leading {SLUG_LEN} normalised chars match — see normaliseDeadLetterMessage. */
const MESSAGE_SLUG_LEN = 80;

export interface DeadLetterFingerprintInput {
  /** The route the failure was bound for; null/'' both fold to the empty
   * string, so a writer may store either and still match the inbox. */
  route_id: string | null;
  /** The failure reason exactly as stored in dead_letters.reason. */
  reason: string;
  /** The failure message exactly as stored in dead_letters.message (i.e. AFTER
   * any truncation the writer applies — hash what you INSERT, not the raw). */
  message: string;
}

/**
 * Compute the 16-hex-char dead-letter fingerprint. Async because Web Crypto's
 * digest is async; callers in the inbox hot path await it per row.
 */
export async function deadLetterFingerprint(input: DeadLetterFingerprintInput): Promise<string> {
  const slug = normaliseDeadLetterMessage(input.message).slice(0, MESSAGE_SLUG_LEN);
  const bytes = new TextEncoder().encode(`${input.route_id ?? ""}|${input.reason}|${slug}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  // Slice on the HEX string (16 chars = 8 bytes), never on the digest bytes.
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}

/**
 * Strip the noisy parts that vary per-event but don't change the underlying
 * failure: timestamps, UUIDs, bare numbers (ids, IPs, line numbers). The result
 * is fed into the hash so two messages that differ only in those places
 * fingerprint the same. Kept identical to the original inbox formula.
 */
export function normaliseDeadLetterMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[\d.]*z?\b/g, "<ts>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}
