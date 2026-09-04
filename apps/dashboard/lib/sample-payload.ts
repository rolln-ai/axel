import "server-only";

import {
  cloudflareR2ObjectUrl,
  isCanonicalRawPayloadKey,
  resolveRawPayloadBucket,
  type RawPayloadKeyExpectation,
} from "@axel/shared";
import { GENERIC_SAMPLE, TEST_PAYLOADS } from "./test-payloads";

/**
 * Server-only payload utilities.
 *
 * Re-exports client-safe data from test-payloads.ts so existing server imports
 * (field selection, data contracts, etc.) continue to work without changes.
 */

// Re-export pure data so existing imports of GENERIC_SAMPLE and TEST_PAYLOADS
// from this file keep working (server components can still import them).
export { GENERIC_SAMPLE, TEST_PAYLOADS };

/**
 * Fetch the raw payload of an event from R2. Returns parsed JSON on
 * success; `null` on creds-missing / non-2xx / network error.
 *
 * Uses the Cloudflare R2 HTTP API (account-scoped). The dashboard server
 * runtime needs CLOUDFLARE_R2_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to call it.
 *
 * Why null instead of GENERIC_SAMPLE on failure: substituting a sample
 * payload poisoned the Data Contracts inference pipeline — every failed
 * fetch ended up clustered as the sample's `type` field, producing a
 * fake Stripe `payment_intent.succeeded` cluster on sources that had
 * never seen Stripe traffic. A synthetic newsletter source with 800,000
 * events was used to lock this regression. UI preview callers that
 * want a placeholder must explicitly opt in with `?? GENERIC_SAMPLE`.
 */

interface FetchOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  bucket?: string;
}

const MAX_DASHBOARD_RAW_PAYLOAD_BYTES = 5 * 1024 * 1024;

export async function fetchPayloadForR2Key(
  r2Key: string,
  expected: RawPayloadKeyExpectation,
  options: FetchOptions = {},
): Promise<unknown | null> {
  if (!isCanonicalRawPayloadKey(r2Key, expected)) return null;
  const env = options.env ?? process.env;
  const token = env.CLOUDFLARE_R2_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = options.bucket ?? resolveRawPayloadBucket(env);
  if (!token || !accountId) return null;

  const url = cloudflareR2ObjectUrl(accountId, bucket, r2Key);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const text = new TextDecoder().decode(
      await readResponseBytesLimited(res, MAX_DASHBOARD_RAW_PAYLOAD_BYTES),
    );
    try {
      return JSON.parse(text);
    } catch {
      // Non-JSON payload — return as a wrapped shape so the projection
      // preview still has something to show.
      return { raw: text.slice(0, 500) };
    }
  } catch {
    return null;
  }
}

/**
 * Same R2 fetch as `fetchPayloadForR2Key`, but returns the raw bytes
 * base64-encoded so the caller can ship binary-safe payloads to a
 * client component (e.g. the AXE-53 cURL/Replay panel). Returns null
 * when CF creds aren't set or the fetch fails — caller decides how to
 * surface it. Capped at 5 MB to keep page payloads sane.
 */
export async function fetchRawPayloadBase64ForR2Key(
  r2Key: string,
  expected: RawPayloadKeyExpectation,
  options: FetchOptions = {},
): Promise<string | null> {
  if (!isCanonicalRawPayloadKey(r2Key, expected)) return null;
  const env = options.env ?? process.env;
  const token = env.CLOUDFLARE_R2_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = options.bucket ?? resolveRawPayloadBucket(env);
  if (!token || !accountId) return null;

  const url = cloudflareR2ObjectUrl(accountId, bucket, r2Key);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      redirect: "manual",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(
      await readResponseBytesLimited(res, MAX_DASHBOARD_RAW_PAYLOAD_BYTES),
    );
    return buf.toString("base64");
  } catch {
    return null;
  }
}

async function readResponseBytesLimited(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const declaredBytes = Number(declared);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("raw_payload_too_large");
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("raw_payload_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
