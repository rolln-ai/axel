/**
 * Signed outbound webhook connector.
 *
 * This is what customers reach for when they want Axel to *send* webhooks
 * downstream — the receiver is some service they own (or a partner's), and
 * they need cryptographic proof that the request actually came from Axel.
 *
 * What we send (and why):
 *   - body                — the raw event JSON, exactly as it landed at ingest.
 *   - X-Axel-Timestamp    — unix-second timestamp of when *this attempt* was
 *                            built. Receivers MUST reject requests where
 *                            |now - timestamp| exceeds their tolerance window
 *                            (recommend 5 minutes). Prevents replay of an
 *                            old captured request body+sig.
 *   - X-Axel-Event-Id     — Axel's event_id. Receivers SHOULD use this as an
 *                            idempotency key — Axel retries on 5xx + network
 *                            errors, so the same event_id may arrive twice.
 *   - X-Axel-Webhook-Id   — destination_id. Tells the receiver which webhook
 *                            subscription this request belongs to (a single
 *                            host may serve multiple subscriptions with
 *                            different secrets).
 *   - X-Axel-Signature    — `t=<timestamp>,v1=<hex_hmac>` (Stripe-style).
 *                            The HMAC covers `<timestamp>.<raw_body>` so
 *                            receivers can verify body integrity AND that
 *                            the timestamp itself wasn't tampered with.
 *
 * Verification (receiver-side, in pseudocode):
 *
 *   parse `t` and `v1` from X-Axel-Signature.
 *   require abs(now - t) < 300.
 *   expected = hmac(secret, t + "." + raw_body).
 *   require crypto.timingSafeEqual(expected, v1).
 *
 * The signing scheme is intentionally Stripe-compatible (`t=…,v1=…`) so
 * customers who already verify Stripe webhooks can copy-paste their
 * verification code with only the secret swapped.
 *
 * Retry policy: 2xx → success, 4xx (except 408/429) → dead, everything else
 * → retry. Literally the same code as the plain HTTP connector — see
 * ./classify.ts.
 */

import type { Connector, FetchLike, FetchResponseLike } from "./index.js";
import { classifyDeliveryStatus } from "./classify.js";
import { assertResolvedHostSafe, isSafeHeaderName, isSafeHeaderValue, validateDestinationUrl, type Destination, type DnsLookupAll } from "@axel/shared";
import { fetchWithValidatedRedirects, UnsafeDestinationError } from "./safe-fetch.js";

export type WebhookSigningAlgorithm = "hmac-sha256" | "hmac-sha512";

export interface WebhookDestinationConfig {
  /** Receiver URL (HTTPS strongly recommended). */
  url: string;
  /** HTTP verb. Defaults to POST. */
  method?: "POST" | "PUT" | "PATCH";
  /** Custom headers merged into the request. Cannot override the X-Axel-* trio. */
  headers?: Record<string, string>;
  /** HMAC algorithm. Defaults to hmac-sha256. */
  signing_algorithm?: WebhookSigningAlgorithm;
  /** Custom signature header name. Defaults to X-Axel-Signature. */
  signature_header?: string;
  /** Custom timestamp header name. Defaults to X-Axel-Timestamp. */
  timestamp_header?: string;
  /** Custom event-id header name. Defaults to X-Axel-Event-Id. */
  event_id_header?: string;
  /** Custom webhook-id header name. Defaults to X-Axel-Webhook-Id. */
  webhook_id_header?: string;
  /** Request timeout in ms. Defaults to 10_000. */
  timeout_ms?: number;
  /** Fixed clock for testing. Otherwise Date.now() / 1000 floor. */
  __nowSeconds?: () => number;
  /**
   * The HMAC signing secret. Provided by `mergeCredentialsIntoConfig` at
   * delivery time — never stored on the destination row in plaintext.
   */
  signing_secret?: string;
}

/**
 * Compute Stripe-style signature `t=<ts>,v1=<hex_hmac>` for a webhook delivery.
 *
 * Exposed (and exported) so the dashboard's webhook-tester UI can show
 * customers exactly what their receiver should be verifying.
 */
export async function computeWebhookSignature(input: {
  secret: string;
  body: ArrayBuffer | Uint8Array | string;
  timestampSeconds: number;
  algorithm?: WebhookSigningAlgorithm;
}): Promise<{ header: string; signature: string }> {
  const algorithm = input.algorithm ?? "hmac-sha256";
  const hashName = algorithm === "hmac-sha512" ? "SHA-512" : "SHA-256";
  const enc = new TextEncoder();
  const bodyBytes =
    typeof input.body === "string"
      ? enc.encode(input.body)
      : input.body instanceof Uint8Array
        ? input.body
        : new Uint8Array(input.body);
  // Sign `<timestamp>.<body>` so the timestamp itself is covered by the MAC.
  const tsBytes = enc.encode(`${input.timestampSeconds}.`);
  const msg = new Uint8Array(tsBytes.length + bodyBytes.length);
  msg.set(tsBytes, 0);
  msg.set(bodyBytes, tsBytes.length);

  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(input.secret),
    { name: "HMAC", hash: hashName },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, msg);
  const signature = bytesToHex(new Uint8Array(sigBuf));
  return {
    signature,
    header: `t=${input.timestampSeconds},v1=${signature}`,
  };
}

/**
 * Generate a fresh webhook signing secret. 32 bytes of CSPRNG, base32-ish
 * encoded for readability when copy-pasted (no =, /, or + characters).
 *
 * The dashboard calls this when a customer creates a webhook destination
 * without supplying their own secret — Axel generates one and shows it
 * once before encrypting it. The customer can also rotate it.
 */
export function generateWebhookSecret(rng: () => Uint8Array = randomBytes32): string {
  const bytes = rng();
  // Crockford's Base32 alphabet — visually unambiguous (no I/L/O/U/0/1).
  const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";
  let out = "whsec_";
  // 32 bytes → 51.2 base32 chars; we'll emit 52 then trim to 50 for a
  // human-friendly fixed length.
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

function randomBytes32(): Uint8Array {
  const out = new Uint8Array(32);
  crypto.getRandomValues(out);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Build the request the webhook connector would send for a given event.
 * Pure: no I/O, no fetch. Used by both the connector itself and the
 * dashboard's signature-preview tool so the UI can show customers the
 * exact bytes Axel would put on the wire.
 */
export async function buildSignedWebhookRequest(input: {
  config: WebhookDestinationConfig;
  body: ArrayBuffer | Uint8Array;
  eventId: string;
  destinationId: string;
}): Promise<{
  url: string;
  method: string;
  headers: Record<string, string>;
  body: ArrayBuffer;
  timestamp: number;
  /** True when a signature header was actually written (a secret was present
   *  and non-empty). Callers report this on the delivery attempt. */
  signed: boolean;
}> {
  const { config, body, eventId, destinationId } = input;
  const now = config.__nowSeconds ? config.__nowSeconds() : Math.floor(Date.now() / 1000);

  const sigHeader = config.signature_header ?? "X-Axel-Signature";
  const tsHeader = config.timestamp_header ?? "X-Axel-Timestamp";
  const eventHeader = config.event_id_header ?? "X-Axel-Event-Id";
  const webhookHeader = config.webhook_id_header ?? "X-Axel-Webhook-Id";

  // Custom headers can't shadow the signing-protocol headers — that would
  // let a config typo silently disable verification.
  const reservedLowercase = new Set(
    [sigHeader, tsHeader, eventHeader, webhookHeader].map((h) => h.toLowerCase()),
  );
  // Audit-pass2 — apply the same hardening here as the HTTP
  // connector's auth-headers path: reject RFC 7230 token violations,
  // hop-by-hop / routing-affecting names (Host, Content-Length, …),
  // and CR/LF/NUL in values. Combined with the reserved-name skip
  // below this prevents both signature bypass and request smuggling.
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(config.headers ?? {})) {
    if (reservedLowercase.has(k.toLowerCase())) continue;
    if (!isSafeHeaderName(k) || !isSafeHeaderValue(v)) continue;
    safeHeaders[k] = v;
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...safeHeaders,
    [tsHeader]: String(now),
    [eventHeader]: eventId,
    [webhookHeader]: destinationId,
  };

  let signed = false;
  if (config.signing_secret) {
    // `exactOptionalPropertyTypes` rejects passing `undefined` explicitly;
    // spread the algorithm only when it's actually set so the function's
    // own default ("hmac-sha256") kicks in.
    const { header } = await computeWebhookSignature({
      secret: config.signing_secret,
      body,
      timestampSeconds: now,
      ...(config.signing_algorithm ? { algorithm: config.signing_algorithm } : {}),
    });
    headers[sigHeader] = header;
    signed = true;
  }

  const bodyBuf =
    body instanceof ArrayBuffer
      ? body
      : (body.buffer as ArrayBuffer).slice(body.byteOffset, body.byteOffset + body.byteLength);

  return {
    url: config.url,
    method: config.method ?? "POST",
    headers,
    body: bodyBuf,
    timestamp: now,
    signed,
  };
}

/**
 * Runtime-shaped knobs for the signed-webhook connector. Mirrors
 * `HttpConnectorOptions` — see the note there on why the Workers runtime
 * supplies a default timeout and the Node service does not.
 */
export interface WebhookConnectorOptions {
  /** Fallback timeout when neither `context.timeoutMs` nor `config.timeout_ms` is set. */
  defaultTimeoutMs?: number;
}

export function createWebhookConnector(
  fetchImpl: FetchLike,
  lookup?: DnsLookupAll,
  options: WebhookConnectorOptions = {},
): Connector<WebhookDestinationConfig> {
  return {
    type: "webhook",
    async deliver(event, destination, context) {
      const started = Date.now();
      // AXE-audit-Sev1 — SSRF gate before any network I/O. Same
      // semantics as the HTTP connector: a destination URL that
      // resolves to a private/loopback/metadata range gets a `dead`
      // attempt (permanent config error, no retry).
      const ssrfReason = validateDestinationUrl(destination.config.url);
      if (ssrfReason) {
        return makeAttempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          status: "dead",
          response: { error: `ssrf_blocked: ${ssrfReason}` },
          started,
        });
      }
      // Resolved-IP SSRF check (DNS-rebinding) — only when a resolver is
      // injected (Node delivery path); Cloudflare Workers can't resolve DNS.
      if (lookup) {
        const resolvedReason = await assertResolvedHostSafe(new URL(destination.config.url).hostname, lookup);
        if (resolvedReason) {
          return makeAttempt({
            eventId: context?.eventId ?? "unknown",
            destinationId: destination.destination_id,
            status: "dead",
            response: { error: `ssrf_blocked: ${resolvedReason}` },
            started,
          });
        }
      }
      if (!destination.config.signing_secret) {
        return makeAttempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          status: "dead",
          response: { error: "missing_signing_secret: signed webhook delivery refused" },
          started,
        });
      }
      // Request timeout — same override chain as the HTTP connector
      // (per-attempt override → destination config → runtime default).
      // Until this landed the webhook connector documented `timeout_ms`
      // but never applied it, so a hung receiver held a Node delivery
      // slot open indefinitely.
      const timeoutMs =
        context?.timeoutMs ?? destination.config.timeout_ms ?? options.defaultTimeoutMs;
      const ac = timeoutMs ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
      try {
        const req = await buildSignedWebhookRequest({
          config: destination.config,
          body: event,
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
        });
        const response = await fetchWithValidatedRedirects({
          fetchImpl,
          url: req.url,
          ...(lookup ? { lookup } : {}),
          init: {
            method: req.method,
            headers: req.headers,
            body: req.body,
            ...(ac ? { signal: ac.signal } : {}),
          },
        });
        await discardResponseBody(response);
        return makeAttempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          status: classifyDeliveryStatus(response.status),
          response: {
            status: response.status,
            timestamp: req.timestamp,
            // Don't echo the signature header back into the log — it's not
            // a secret per se but it is unique-per-attempt noise. Reports
            // whether a signature was actually written, not merely whether
            // the field was present (an empty-string secret signs nothing).
            signed: req.signed,
            algorithm: destination.config.signing_algorithm ?? "hmac-sha256",
          },
          started,
        });
      } catch (err) {
        return makeAttempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          status: err instanceof UnsafeDestinationError ? "dead" : "retry",
          response: { error: err instanceof Error ? err.message : String(err) },
          started,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

async function discardResponseBody(response: FetchResponseLike): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response body is deliberately not a delivery diagnostic: a receiver
    // can echo the submitted webhook bytes or return an unbounded body.
  }
}

function makeAttempt(input: {
  eventId: string;
  destinationId: string;
  status: "success" | "retry" | "dead";
  response: unknown;
  started: number;
}): import("@axel/shared").DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: input.eventId,
    destination_id: input.destinationId,
    status: input.status,
    response: input.response,
    latency_ms: Date.now() - input.started,
    created_at: new Date().toISOString(),
  };
}

export type { Destination };
