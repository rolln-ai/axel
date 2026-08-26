import "server-only";

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
 * runtime needs CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID to call it.
 *
 * Why null instead of GENERIC_SAMPLE on failure: substituting a sample
 * payload poisoned the Data Contracts inference pipeline — every failed
 * fetch ended up clustered as the sample's `type` field, producing a
 * fake Stripe `payment_intent.succeeded` cluster on sources that had
 * never seen Stripe traffic (newsletter-webhook, 800,000 events, all clustered
 * under one wrong type until this was fixed). UI preview callers that
 * want a placeholder must explicitly opt in with `?? GENERIC_SAMPLE`.
 */

interface FetchOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  bucket?: string;
}

export async function fetchPayloadForR2Key(
  r2Key: string,
  options: FetchOptions = {},
): Promise<unknown | null> {
  const env = options.env ?? process.env;
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = options.bucket ?? "axel-events-raw";
  if (!token || !accountId) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(r2Key)}`;
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const text = await res.text();
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
  options: FetchOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const token = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const bucket = options.bucket ?? "axel-events-raw";
  if (!token || !accountId) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucket}/objects/${encodeURIComponent(r2Key)}`;
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > 5 * 1024 * 1024) return null;
    return buf.toString("base64");
  } catch {
    return null;
  }
}
