/**
 * Inbound provider signature verification (AXE-23).
 *
 * Pure Web-Crypto based — works identically in Cloudflare Workers (where
 * the ingest-worker runs the verification before any R2/queue write) and
 * in Node 20 (where dashboard tests can exercise the same code paths).
 *
 * Each provider mints signatures slightly differently, so we expose a
 * single `verifyProviderSignature` dispatcher and the per-provider
 * primitives in case a caller wants direct access (e.g. dashboard
 * "test signature" affordance).
 *
 * Security properties:
 *   - All HMAC comparisons go through a constant-time byte compare.
 *   - Stripe / Custom HMAC: timestamp is checked against a tolerance
 *     window to prevent indefinite replay of an intercepted request.
 *   - GitHub / Shopify don't sign a timestamp — only the body — so this
 *     primitive cannot reject stale events the way Stripe does. The ingest
 *     worker separately persists their stable delivery IDs for replay
 *     suppression after signature verification.
 *   - Header lookups are case-insensitive (HTTP normalises but defense
 *     in depth never hurts).
 */

// Minimal Web-Platform global declarations. The runtime providing this
// module (Cloudflare Workers + Node 20 + Vitest) all expose these
// globals natively; the bare `lib: ["ES2022"]` tsconfig the workspace
// inherits doesn't include them. We declare the smallest surface so
// downstream package compilations don't inherit the full DOM lib —
// which conflicts with `@cloudflare/workers-types` Fetch declarations.
declare const crypto: {
  subtle: {
    importKey(
      format: "raw",
      key: ArrayBuffer | Uint8Array,
      algorithm: { name: "HMAC"; hash: "SHA-256" },
      extractable: boolean,
      keyUsages: ("sign" | "verify")[],
    ): Promise<CryptoKey>;
    sign(algorithm: "HMAC", key: CryptoKey, data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer>;
  };
};
declare class CryptoKey {}
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare function btoa(s: string): string;

export type SourceProvider = "custom" | "stripe" | "github" | "shopify" | "chargebee";

export interface SignatureVerifyInput {
  provider: SourceProvider;
  /** Plaintext signing secret stored against the source. Never logged. */
  secret: string;
  /** Raw body bytes exactly as received. */
  body: Uint8Array;
  /** Header map normalised to lowercase keys (Headers#forEach already lowercases). */
  headers: Record<string, string>;
  /**
   * Optional clock for tests. Defaults to Date.now(). Must be ms since epoch.
   */
  now?: number;
  /**
   * Tolerance window for timestamped providers (Stripe / Custom HMAC).
   * Default 5 minutes. Anything older than `now - tolerance` is rejected.
   */
  toleranceSeconds?: number;
}

export interface SignatureVerifyResult {
  ok: boolean;
  /**
   * Stable reason slug suitable for a 401/403 body, ClickHouse stamp,
   * or Sentry tag. Never includes the secret or the body.
   */
  reason:
    | "ok"
    | "missing_signature"
    | "missing_timestamp"
    | "stale_timestamp"
    | "invalid_signature"
    | "missing_secret"
    | "unsupported_provider";
}

const DEFAULT_TOLERANCE_SECONDS = 300;

export async function verifyProviderSignature(
  input: SignatureVerifyInput,
): Promise<SignatureVerifyResult> {
  const headers = lowercaseHeaders(input.headers);
  if (!input.secret || input.secret.length === 0) {
    return { ok: false, reason: "missing_secret" };
  }
  switch (input.provider) {
    case "custom":
      return verifyCustomHmac(input.secret, input.body, headers, input.now, input.toleranceSeconds);
    case "stripe":
      return verifyStripeSignature(input.secret, input.body, headers, input.now, input.toleranceSeconds);
    case "github":
      return verifyGithubSignature(input.secret, input.body, headers);
    case "shopify":
      return verifyShopifySignature(input.secret, input.body, headers);
    case "chargebee":
      return verifyChargebeeBasicAuth(input.secret, headers);
    default:
      return { ok: false, reason: "unsupported_provider" };
  }
}

/**
 * Verify against several candidate secrets (current + previous), returning ok
 * on the FIRST that matches. This is the overlapping-window for signing-secret
 * rotation: after a rotation, in-flight provider webhooks still signed with the
 * old secret keep verifying until the previous secret is retired. Empty/missing
 * secrets are skipped; with none, returns `missing_secret`.
 */
export async function verifyProviderSignatureWithSecrets(
  input: Omit<SignatureVerifyInput, "secret">,
  secrets: ReadonlyArray<string | null | undefined>,
): Promise<SignatureVerifyResult> {
  const candidates = secrets.filter((s): s is string => typeof s === "string" && s.length > 0);
  if (candidates.length === 0) return { ok: false, reason: "missing_secret" };
  let last: SignatureVerifyResult = { ok: false, reason: "missing_secret" };
  for (const secret of candidates) {
    const result = await verifyProviderSignature({ ...input, secret });
    if (result.ok) return result;
    last = result;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Stripe — signs `${timestamp}.${body}` with HMAC-SHA256, header
//   `Stripe-Signature: t=<unix>,v1=<hex>[,v0=<hex>]`
// Stripe rotates secrets via webhook endpoints; we accept a single secret
// here. Multi-secret rotation can be modeled later as `secret: string[]`.
// ---------------------------------------------------------------------------
export async function verifyStripeSignature(
  secret: string,
  body: Uint8Array,
  headers: Record<string, string>,
  now: number = Date.now(),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<SignatureVerifyResult> {
  const header = headers["stripe-signature"];
  if (!header) return { ok: false, reason: "missing_signature" };
  const parts = parseKeyValueList(header, ",", "=");
  const tsStr = parts.t;
  const v1 = parts.v1;
  if (!tsStr) return { ok: false, reason: "missing_timestamp" };
  if (!v1) return { ok: false, reason: "missing_signature" };
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing_timestamp" };
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const signedPayload = concatBytes(
    new TextEncoder().encode(`${ts}.`),
    body,
  );
  const expected = await hmacSha256Hex(secret, signedPayload);
  return constantTimeEqual(expected, v1)
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "invalid_signature" };
}

// ---------------------------------------------------------------------------
// GitHub — `X-Hub-Signature-256: sha256=<hex>` over the raw body.
// Older `X-Hub-Signature` (sha1) is intentionally ignored — sha1 has been
// deprecated by GitHub since 2020 and we don't want to widen the trusted
// surface for a weaker hash.
// ---------------------------------------------------------------------------
export async function verifyGithubSignature(
  secret: string,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<SignatureVerifyResult> {
  const header = headers["x-hub-signature-256"];
  if (!header) return { ok: false, reason: "missing_signature" };
  const prefix = "sha256=";
  if (!header.startsWith(prefix)) return { ok: false, reason: "invalid_signature" };
  const presented = header.slice(prefix.length);
  const expected = await hmacSha256Hex(secret, body);
  return constantTimeEqual(expected, presented)
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "invalid_signature" };
}

// ---------------------------------------------------------------------------
// Shopify — `X-Shopify-Hmac-Sha256: <base64>` over the raw body.
// Shopify base64-encodes (rather than hex), so we encode the expected
// digest the same way before comparing.
// ---------------------------------------------------------------------------
export async function verifyShopifySignature(
  secret: string,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<SignatureVerifyResult> {
  const header = headers["x-shopify-hmac-sha256"];
  if (!header) return { ok: false, reason: "missing_signature" };
  const expected = await hmacSha256Base64(secret, body);
  return constantTimeEqual(expected, header)
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "invalid_signature" };
}

// ---------------------------------------------------------------------------
// Chargebee — webhooks are secured with HTTP Basic Auth (a username:password
// configured on the webhook endpoint in Chargebee), NOT an HMAC body
// signature. We verify the `Authorization: Basic <base64(user:pass)>` header
// against the stored credential with a constant-time compare. Like
// GitHub/Shopify this authenticates the SENDER via a shared secret but does
// not prove body integrity — that is Chargebee's design, not ours. The stored
// signing secret is the `username:password` string configured in Chargebee.
// ---------------------------------------------------------------------------
export function verifyChargebeeBasicAuth(
  secret: string,
  headers: Record<string, string>,
): SignatureVerifyResult {
  const header = headers["authorization"];
  if (!header) return { ok: false, reason: "missing_signature" };
  const expected = `Basic ${bytesToBase64(new TextEncoder().encode(secret))}`;
  return constantTimeEqual(expected, header)
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "invalid_signature" };
}

// ---------------------------------------------------------------------------
// Custom HMAC — Stripe-style timestamped HMAC-SHA256, but with a
// configurable header. For MVP we accept the same headers Axel itself
// emits on outbound webhooks: `X-Axel-Signature: t=<unix>,v1=<hex>`
// + `X-Axel-Timestamp: <unix>`. Customers using a producer that signs
// raw bytes without a timestamp can fall back to a no-op `custom`
// provider with no signing secret (which is then equivalent to the
// pre-AXE-23 token-only behavior).
// ---------------------------------------------------------------------------
export async function verifyCustomHmac(
  secret: string,
  body: Uint8Array,
  headers: Record<string, string>,
  now: number = Date.now(),
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<SignatureVerifyResult> {
  const sigHeader = headers["x-axel-signature"];
  if (!sigHeader) return { ok: false, reason: "missing_signature" };
  const parts = parseKeyValueList(sigHeader, ",", "=");
  const tsStr = parts.t;
  const v1 = parts.v1;
  if (!tsStr) return { ok: false, reason: "missing_timestamp" };
  if (!v1) return { ok: false, reason: "missing_signature" };
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts)) return { ok: false, reason: "missing_timestamp" };
  if (Math.abs(now / 1000 - ts) > toleranceSeconds) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const signed = concatBytes(new TextEncoder().encode(`${ts}.`), body);
  const expected = await hmacSha256Hex(secret, signed);
  return constantTimeEqual(expected, v1)
    ? { ok: true, reason: "ok" }
    : { ok: false, reason: "invalid_signature" };
}

// ---------------------------------------------------------------------------
// Crypto helpers — Web Crypto only, so the same code runs in CF Workers
// (no node:crypto), Node 20, and tests under Vitest with no shims.
// ---------------------------------------------------------------------------

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function hmacSha256Hex(secret: string, data: Uint8Array): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return bytesToHex(sig);
}

async function hmacSha256Base64(secret: string, data: Uint8Array): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return bytesToBase64(sig);
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Avoid Buffer (not present in the CF runtime): build string then btoa.
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  // btoa exists in CF Workers + Node 20+
  return btoa(bin);
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function parseKeyValueList(
  raw: string,
  pairSep: string,
  kvSep: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(pairSep)) {
    const idx = part.indexOf(kvSep);
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key.length === 0) continue;
    // First-write wins: Stripe headers may contain multiple `v1=` entries
    // for in-flight rotation. We only verify against the first; callers
    // wanting n-secret rotation can pass each candidate and OR the
    // results.
    if (!(key in out)) out[key] = val;
  }
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
