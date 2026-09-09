import "server-only";
import { createHash, randomBytes } from "node:crypto";

/**
 * Source ingest tokens are stored as SHA-256 hashes (matching the existing
 * `sources.secret_token_hash` column). The plaintext token is shown to the
 * operator exactly once at creation time and must be saved by them.
 *
 * NOTE: this file is server-only. Client-safe defaults live in
 * `source-defaults.ts` so they can be imported from form components without
 * pulling node:crypto into the browser bundle.
 */
const TOKEN_BYTES = 24;

export function generateSourceToken(): { plaintext: string; hash: string } {
  const plaintext = `axt_${randomBytes(TOKEN_BYTES).toString("base64url")}`;
  return { plaintext, hash: hashSourceToken(plaintext) };
}

/** Independent of header tokens so URL rotation does not interrupt other senders. */
export function generateSourceUrlToken(): { plaintext: string; hash: string } {
  const plaintext = `axu_${randomBytes(32).toString("base64url")}`;
  return { plaintext, hash: hashSourceToken(plaintext) };
}

function hashSourceToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Re-export defaults so existing server-side imports of source-tokens still
// resolve them — but the canonical source is source-defaults.ts.
export { DEFAULT_SOURCE_LIMITS } from "./source-defaults";
