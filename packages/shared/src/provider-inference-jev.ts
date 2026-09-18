/**
 * Model-backed provider inference using TypeSafe AI's Jev (System One).
 *
 * Jev answers typed "choice" questions with a probability spread and a
 * calibrated confidence, which is the same shape `inferProvider` in
 * ./provider-inference.ts already returns from its hand-written rules.
 * This module layers Jev on top of those rules:
 *
 *   - No key configured → heuristics only (`inferProvider`). Nothing changes.
 *   - Key configured → heuristics run first. A header smoking gun
 *     (confidence >= `shortCircuitConfidence`) skips the network call.
 *     Otherwise Jev is asked which provider the sample came from, and the
 *     answer with the higher confidence wins.
 *   - Any Jev failure (network, 4xx/5xx, timeout, bad body) falls back to
 *     the heuristic result. Inference never throws because of Jev.
 *
 * Privacy: no primitive webhook value crosses to Jev. The model sees the
 * schema-only summary from `summarizeWebhookDataForAi` (field names and
 * value kinds) and header NAMES, never header values. Event-type values
 * are read locally; Jev is only asked which field name holds the type.
 *
 * Runtime: plain `fetch`, no SDK, no `process` reference. Loads in Node,
 * Cloudflare Workers, and the browser. Callers pass env explicitly via
 * `resolveJevConfig(env)`.
 */

import {
  isSecretLikeWebhookKey,
  safeWebhookSchemaKey,
  summarizeWebhookDataForAi,
} from "./ai-redaction.js";
import { extractEventTypeFromHeaders, extractEventTypeFromValue } from "./event-type.js";
import {
  inferProvider,
  type InferenceInput,
  type InferredProvider,
  type InferredProviderResult,
} from "./provider-inference.js";

export const JEV_DEFAULT_BASE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_DEFAULT_MODEL = "jev-latest";
export const JEV_DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Below this, Jev's own docs say "route to a human or fall back". We fall
 * back to the heuristic result.
 */
export const JEV_MIN_CONFIDENCE = 0.5;

/**
 * Heuristic confidence at or above which we don't bother calling Jev.
 * 0.9+ is reserved for header smoking guns in ./provider-inference.ts.
 */
export const JEV_SHORT_CIRCUIT_CONFIDENCE = 0.9;

export type InferenceSource = "heuristic" | "jev";

export interface JevInferenceConfig {
  apiKey: string;
  /** Defaults to {@link JEV_DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Defaults to {@link JEV_DEFAULT_MODEL}. */
  model?: string;
  /** Defaults to {@link JEV_DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Defaults to {@link JEV_SHORT_CIRCUIT_CONFIDENCE}. */
  shortCircuitConfidence?: number;
  /** Defaults to {@link JEV_MIN_CONFIDENCE}. */
  minConfidence?: number;
}

export interface ProviderInferenceOutcome extends InferredProviderResult {
  /** Which engine produced the winning answer. */
  source: InferenceSource;
  /** Jev's full distribution over providers, when Jev was consulted. */
  probabilities?: Record<string, number>;
  /** Set when Jev was configured but the call failed; heuristics answered. */
  jev_error?: string;
}

/**
 * Read Jev settings from an env record (pass `process.env` in Node, the
 * Worker `env` binding in Workers). Returns null when no key is set, which
 * callers treat as "heuristics only".
 */
export function resolveJevConfig(
  env: Record<string, string | undefined>,
): JevInferenceConfig | null {
  const apiKey = env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) return null;
  const config: JevInferenceConfig = { apiKey };
  if (env.TYPESAFE_BASE_URL?.trim()) config.baseUrl = env.TYPESAFE_BASE_URL.trim();
  if (env.TYPESAFE_MODEL?.trim()) config.model = env.TYPESAFE_MODEL.trim();
  const timeout = Number.parseInt(env.TYPESAFE_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(timeout) && timeout > 0) config.timeoutMs = timeout;
  return config;
}

/**
 * Entry point for callers: Jev when configured, heuristics otherwise.
 * Never rejects because of Jev; see module docs.
 */
export async function inferProviderAuto(
  input: InferenceInput,
  jev: JevInferenceConfig | null | undefined,
): Promise<ProviderInferenceOutcome> {
  if (!jev) return { ...inferProvider(input), source: "heuristic" };
  return inferProviderWithJev(input, jev);
}

/** Jev-backed inference with heuristic fallback. */
export async function inferProviderWithJev(
  input: InferenceInput,
  config: JevInferenceConfig,
): Promise<ProviderInferenceOutcome> {
  const heuristic: ProviderInferenceOutcome = { ...inferProvider(input), source: "heuristic" };
  const shortCircuit = config.shortCircuitConfidence ?? JEV_SHORT_CIRCUIT_CONFIDENCE;
  if (heuristic.confidence >= shortCircuit) return heuristic;

  let answers: JevAnswers;
  try {
    answers = await askJev(buildJevRequest(input, config), config);
  } catch (err) {
    return { ...heuristic, jev_error: describeError(err) };
  }

  return mergeAnswers(input, heuristic, answers, config.minConfidence ?? JEV_MIN_CONFIDENCE);
}

// ---------------------------------------------------------------------------
// Request construction
// ---------------------------------------------------------------------------

export const PROVIDER_CRITERIA: Record<InferredProvider, string> = {
  stripe:
    "Stripe webhook. Envelope has id, object: 'event', type like 'charge.succeeded', data.object, livemode, api_version. Header stripe-signature.",
  github:
    "GitHub webhook. Fields like repository (with full_name), sender, action, pull_request, ref, commits, installation. Headers x-github-event, x-github-delivery, x-hub-signature-256.",
  shopify:
    "Shopify Admin webhook. Flat resource such as an order or product: integer id, admin_graphql_api_id, currency, email, line_items, created_at. Headers x-shopify-topic, x-shopify-hmac-sha256, x-shopify-shop-domain.",
  chargebee:
    "Chargebee webhook. Fields id, occurred_at, source, event_type in snake_case like 'subscription_created', and a content object holding subscription, customer, invoice.",
  custom:
    "None of the above. A first-party or unknown sender with its own JSON shape.",
};

/** Jev request body, exported so tests and the smoke script can inspect it. */
export interface JevRequest {
  model: string;
  state: unknown;
  questions: Record<string, JevChoiceQuestion>;
}

export interface JevChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
}

const MAX_EVENT_TYPE_CANDIDATES = 40;
const MAX_HEADER_NAMES = 40;
const EVENT_TYPE_NONE = "none";

export function buildJevRequest(input: InferenceInput, config: JevInferenceConfig): JevRequest {
  const headerNames = Object.keys(input.headers ?? {})
    .map((h) => h.toLowerCase())
    .filter((h) => /^[a-z0-9-]{1,64}$/.test(h))
    .sort()
    .slice(0, MAX_HEADER_NAMES);

  const questions: Record<string, JevChoiceQuestion> = {
    provider: {
      type: "choice",
      instructions:
        "This is the schema of a webhook payload (field names and value kinds only; every value is masked) plus the names of the HTTP headers it arrived with. Which provider sent it?",
      criteria: { ...PROVIDER_CRITERIA },
    },
  };

  const candidates = eventTypeCandidates(input.payload);
  if (candidates.length > 0) {
    const criteria: Record<string, string | null> = {};
    for (const key of candidates) criteria[key] = null;
    criteria[EVENT_TYPE_NONE] = "No top-level field holds the event type.";
    questions.event_type_field = {
      type: "choice",
      instructions:
        "Which top-level field name holds the event type or topic (a short discriminator like 'invoice.paid', 'push', or 'orders/create')?",
      criteria,
    };
  }

  return {
    model: config.model ?? JEV_DEFAULT_MODEL,
    state: {
      header_names: headerNames,
      payload_schema: summarizeWebhookDataForAi(input.payload),
    },
    questions,
  };
}

/**
 * Top-level keys whose value is a short string. Only keys that pass the
 * schema-key safety check are offered, so no customer data leaks via a key.
 */
function eventTypeCandidates(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (value.length === 0 || value.length > 80) continue;
    if (key === EVENT_TYPE_NONE) continue;
    if (!safeWebhookSchemaKey(key) || isSecretLikeWebhookKey(key)) continue;
    out.push(key);
    if (out.length >= MAX_EVENT_TYPE_CANDIDATES) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

type JevAnswers = Record<string, JevChoiceAnswer>;

export class JevError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

async function askJev(body: JevRequest, config: JevInferenceConfig): Promise<JevAnswers> {
  const doFetch = config.fetch ?? globalThis.fetch;
  if (typeof doFetch !== "function") throw new JevError("fetch is not available");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await doFetch(config.baseUrl ?? JEV_DEFAULT_BASE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new JevError(
      controller.signal.aborted ? "request timed out" : `request failed: ${describeError(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new JevError(`HTTP ${res.status}`, res.status);

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new JevError("response was not JSON", res.status);
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== "object") throw new JevError("response had no answers");

  const out: JevAnswers = {};
  for (const [id, raw] of Object.entries(answers as Record<string, unknown>)) {
    const a = raw as Partial<JevChoiceAnswer> | null;
    if (
      a
      && a.type === "choice"
      && typeof a.choice === "string"
      && typeof a.confidence === "number"
      && a.probabilities
      && typeof a.probabilities === "object"
    ) {
      out[id] = a as JevChoiceAnswer;
    }
  }
  if (!out.provider) throw new JevError("response missing provider answer");
  return out;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const PROVIDERS = new Set<string>(Object.keys(PROVIDER_CRITERIA));

function mergeAnswers(
  input: InferenceInput,
  heuristic: ProviderInferenceOutcome,
  answers: JevAnswers,
  minConfidence: number,
): ProviderInferenceOutcome {
  const providerAnswer = answers.provider!;
  const probabilities = providerAnswer.probabilities;

  if (!PROVIDERS.has(providerAnswer.choice)) {
    return { ...heuristic, probabilities, jev_error: `unknown provider ${providerAnswer.choice}` };
  }
  const provider = providerAnswer.choice as InferredProvider;
  const jevConfidence = clamp01(providerAnswer.confidence);
  const p = clamp01(probabilities[provider] ?? 0);

  // Jev decides only when it clears the floor and beats the rules.
  if (jevConfidence < minConfidence || jevConfidence <= heuristic.confidence) {
    return { ...heuristic, probabilities };
  }

  const eventType = resolveEventType(input, answers.event_type_field, minConfidence, heuristic);

  return {
    provider,
    event_type: eventType.value,
    confidence: jevConfidence,
    why: `Jev picked ${provider} (p=${p.toFixed(2)}, confidence ${jevConfidence.toFixed(2)}) from the payload shape and header names.${eventType.why}`,
    source: "jev",
    probabilities,
  };
}

function resolveEventType(
  input: InferenceInput,
  answer: JevChoiceAnswer | undefined,
  minConfidence: number,
  heuristic: ProviderInferenceOutcome,
): { value: string | null; why: string } {
  // Rules first: they know provider-specific header conventions.
  if (heuristic.event_type) return { value: heuristic.event_type, why: "" };
  const local = extractEventTypeFromValue(input.payload) ?? extractEventTypeFromHeaders(input.headers);
  if (local) return { value: local, why: "" };

  if (
    answer
    && answer.choice !== EVENT_TYPE_NONE
    && clamp01(answer.confidence) >= minConfidence
    && input.payload
    && typeof input.payload === "object"
    && !Array.isArray(input.payload)
  ) {
    const value = (input.payload as Record<string, unknown>)[answer.choice];
    if (typeof value === "string" && value.length > 0 && value.length <= 80) {
      return { value, why: ` Event type read from \`${answer.choice}\`.` };
    }
  }
  return { value: null, why: "" };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
