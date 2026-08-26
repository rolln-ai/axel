/**
 * Webhook signing-secret generation, kept in-tree so the dashboard's server
 * actions don't need to import `@axel/connectors` at build time.
 *
 * Why duplicate (rather than re-export from the connectors package): the
 * connectors package exports its source verbatim from `package.json` and uses
 * `import "./webhook.js"` in its barrel — Next.js + Turbopack refuses to
 * resolve that across the workspace boundary even with `transpilePackages`.
 * Pulling the 30-line helper into the dashboard sidesteps the resolver
 * dance, and the runtime side (delivery-edge / delivery-service) still owns
 * its own copies of the matching signing logic.
 *
 * The output format MUST stay byte-compatible with
 * `packages/connectors/src/webhook.ts#generateWebhookSecret` so a secret
 * generated here verifies correctly when delivery time signs an outbound
 * request. Tests in `packages/connectors/test/webhook.test.ts` cover the
 * connector side; this file is the dashboard's mirror.
 */

import { randomBytes } from "node:crypto";

/** Crockford's Base32 alphabet — visually unambiguous (no I/L/O/U/0/1). */
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/**
 * Returns a fresh `whsec_` prefixed signing secret. 50 base32 characters of
 * entropy (so ~250 bits) — well above the 128-bit floor recommended for
 * HMAC keys, and the same shape Stripe uses for `whsec_…` values.
 */
export function generateWebhookSecret(): string {
  const bytes = randomBytes(32);
  let out = "whsec_";
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < bytes.length; i++) {
    buffer = (buffer << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >> bits) & 0x1f]!;
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 0x1f]!;
  return out.slice(0, 6 + 50); // whsec_ + 50 chars
}
