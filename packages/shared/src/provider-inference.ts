/**
 * Provider inference (AXE-56) — given a sample webhook payload + the
 * headers that came with it, guess the provider preset.
 *
 * Pure: no I/O, no side effects, runs identically in browser, Node,
 * and Cloudflare Workers. Designed to grow — new signals slot in as
 * extra `match*` calls in `inferProvider`. Returns the highest-
 * confidence match (or `custom` when nothing matched), the parsed
 * event type if we could find one, and a short `why` string for the
 * UI to surface to the operator.
 *
 * Confidence semantics:
 *   - 0.9+ : header is a smoking gun (e.g. `Stripe-Signature` →
 *            Stripe). Almost zero false-positive risk.
 *   - 0.7..0.9 : payload shape is highly characteristic
 *                (e.g. `id` matching `evt_…` for Stripe).
 *   - <0.7 : weak signal; we still surface it but the UI may want
 *            to flag the inference as "best guess".
 */

export type InferredProvider = "stripe" | "github" | "shopify" | "chargebee" | "custom";

export interface InferredProviderResult {
  provider: InferredProvider;
  /** Best-guess event type extracted from the payload, if any. */
  event_type: string | null;
  /** 0..1; 1 = certain, 0 = pure fallback. */
  confidence: number;
  /** Short, human-readable signal that drove the match. */
  why: string;
}

export interface InferenceInput {
  /** Parsed JSON body. Strings welcome (we'll stringify them in the path tests). */
  payload: unknown;
  /** Header map. Case-insensitive — we lowercase before matching. */
  headers?: Record<string, string>;
}

const FALLBACK: InferredProviderResult = {
  provider: "custom",
  event_type: null,
  confidence: 0,
  why: "No provider-specific signals matched — defaulting to a custom HMAC preset.",
};

export function inferProvider(input: InferenceInput): InferredProviderResult {
  const headers = lowercaseHeaders(input.headers ?? {});
  const payload = input.payload;
  const candidates: InferredProviderResult[] = [];

  const stripe = matchStripe(payload, headers);
  if (stripe) candidates.push(stripe);

  const github = matchGithub(payload, headers);
  if (github) candidates.push(github);

  const shopify = matchShopify(payload, headers);
  if (shopify) candidates.push(shopify);

  const chargebee = matchChargebee(payload, headers);
  if (chargebee) candidates.push(chargebee);

  if (candidates.length === 0) return FALLBACK;

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0]!;
}

// ---------------------------------------------------------------------------
// Stripe
// Header `Stripe-Signature: t=…,v1=…` is the smoking gun.
// Top-level `id` matching `evt_…` AND `object: "event"` is the next-best.
// `type` field is the event type (e.g. "charge.succeeded").
// ---------------------------------------------------------------------------

function matchStripe(payload: unknown, headers: Record<string, string>): InferredProviderResult | null {
  if (headers["stripe-signature"]) {
    return {
      provider: "stripe",
      event_type: extractStringField(payload, "type"),
      confidence: 0.95,
      why: "`Stripe-Signature` header present.",
    };
  }
  if (
    isPlainObject(payload)
    && typeof payload.id === "string"
    && /^evt_/.test(payload.id)
    && payload.object === "event"
  ) {
    return {
      provider: "stripe",
      event_type: extractStringField(payload, "type"),
      confidence: 0.85,
      why: "Top-level `id` starts with `evt_` and `object` is `event` — Stripe webhook envelope.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// GitHub
// Header `X-GitHub-Event: <event>` is the smoking gun.
// Header `X-GitHub-Delivery: <uuid>` corroborates.
// Top-level `repository.full_name` is highly characteristic but appears
// across many GitHub event shapes.
// ---------------------------------------------------------------------------

function matchGithub(payload: unknown, headers: Record<string, string>): InferredProviderResult | null {
  if (headers["x-github-event"]) {
    return {
      provider: "github",
      event_type: headers["x-github-event"]!,
      confidence: 0.95,
      why: "`X-GitHub-Event` header present.",
    };
  }
  if (
    isPlainObject(payload)
    && isPlainObject(payload.repository)
    && typeof (payload.repository as { full_name?: unknown }).full_name === "string"
  ) {
    return {
      provider: "github",
      event_type: typeof payload.action === "string" ? `${payload.action}` : null,
      confidence: 0.7,
      why: "`repository.full_name` present — characteristic of GitHub webhook shapes.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shopify
// Header `X-Shopify-Topic: orders/create` is the smoking gun.
// Top-level `id` is integer + `currency` field present is a weaker signal.
// ---------------------------------------------------------------------------

function matchShopify(payload: unknown, headers: Record<string, string>): InferredProviderResult | null {
  if (headers["x-shopify-topic"]) {
    return {
      provider: "shopify",
      event_type: headers["x-shopify-topic"]!,
      confidence: 0.95,
      why: "`X-Shopify-Topic` header present.",
    };
  }
  if (headers["x-shopify-hmac-sha256"]) {
    return {
      provider: "shopify",
      event_type: null,
      confidence: 0.9,
      why: "`X-Shopify-Hmac-Sha256` header present.",
    };
  }
  if (
    isPlainObject(payload)
    && typeof payload.id === "number"
    && typeof payload.currency === "string"
    && typeof payload.email === "string"
  ) {
    return {
      provider: "shopify",
      event_type: null,
      confidence: 0.7,
      why: "Integer `id` + `currency` + `email` — characteristic of Shopify Admin payloads.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chargebee
// `event_type: "subscription_created"` (snake_case) and a `content`
// envelope are characteristic. Header `Authorization: Basic …` doesn't
// uniquely identify Chargebee, so we lean on the body shape.
// ---------------------------------------------------------------------------

function matchChargebee(payload: unknown, _headers: Record<string, string>): InferredProviderResult | null {
  if (
    isPlainObject(payload)
    && typeof payload.event_type === "string"
    && /_/.test(payload.event_type)
    && isPlainObject(payload.content)
  ) {
    return {
      provider: "chargebee",
      event_type: payload.event_type,
      confidence: 0.8,
      why: "snake_case `event_type` + `content` envelope — Chargebee webhook shape.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lowercaseHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

function extractStringField(payload: unknown, key: string): string | null {
  if (!isPlainObject(payload)) return null;
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

/**
 * Convenience helper for the dashboard's bootstrap panel: parse the
 * pasted blob (which may be just a JSON body, or an HTTP-style paste
 * with headers + blank line + body), run inference, return the
 * extracted JSON + the inference. Pure JSON is the common case;
 * curl-style pastes are nice-to-have.
 */
export interface ParsedPaste {
  payload: unknown;
  headers: Record<string, string>;
  parse_error: string | null;
}

export function parsePastedSample(raw: string): ParsedPaste {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { payload: null, headers: {}, parse_error: "Paste is empty." };
  }

  // Pure-JSON fast path: starts with `{` or `[`.
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { payload: JSON.parse(trimmed), headers: {}, parse_error: null };
    } catch {
      return { payload: null, headers: {}, parse_error: "JSON parse failed." };
    }
  }

  // HTTP-style paste: headers, blank line, body. Common when somebody
  // copies a request out of `curl -v` or Postman's "Code" panel.
  const blank = trimmed.indexOf("\n\n");
  if (blank > 0) {
    const headerBlock = trimmed.slice(0, blank);
    const body = trimmed.slice(blank + 2).trim();
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const k = line.slice(0, colon).trim();
      const v = line.slice(colon + 1).trim();
      if (k.length > 0) headers[k] = v;
    }
    try {
      const payload = body.length > 0 ? JSON.parse(body) : null;
      return { payload, headers, parse_error: null };
    } catch {
      return { payload: null, headers, parse_error: "Body wasn't valid JSON." };
    }
  }

  return { payload: null, headers: {}, parse_error: "Couldn't parse — paste either a JSON body or a `headers\\n\\nbody` block." };
}
