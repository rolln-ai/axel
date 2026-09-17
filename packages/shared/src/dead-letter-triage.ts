/**
 * Dead-letter triage with TypeSafe AI's Jev.
 *
 * A dead letter is a delivery Axel gave up on. Today an operator reads the
 * inbox and decides whether to replay it. This module asks Jev for a typed
 * reason so the delivery-service can replay the transient ones on its own
 * and leave the rest for a human:
 *
 *   transient        the destination hiccuped; a replay should land
 *   destination_down the destination is unreachable or failing; wait
 *   schema_mismatch  the destination rejected the row shape or types
 *   bad_payload      the event itself is unusable
 *   auth_or_config   credentials or configuration are wrong; a human fixes
 *
 * Privacy: Jev never sees the payload, the diagnostic text, or any name. It
 * gets an allowlisted reason slug, an allowlisted destination type, a fixed
 * vocabulary of signal tokens matched against the diagnostic locally, an
 * HTTP status when one is present, and a few counts about how often this
 * fingerprint has failed and whether earlier replays of it succeeded.
 *
 * Pure `fetch`; no `process` reference. Loads in Node and in Workers.
 */

import {
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_TIMEOUT_MS,
  JevError,
  type JevInferenceConfig,
} from "./provider-inference-jev.js";

export const DEAD_LETTER_TRIAGE_REASONS = [
  "transient",
  "destination_down",
  "schema_mismatch",
  "bad_payload",
  "auth_or_config",
] as const;
export type DeadLetterTriageReason = (typeof DEAD_LETTER_TRIAGE_REASONS)[number];

/**
 * Confidence floor for automatic replay. Jev's docs put "act automatically"
 * above 0.9, but a replay is cheap and at-least-once by contract (destinations
 * dedupe on the delivery id), and in live checks Jev's spread-based confidence
 * for clear transient cases sits around 0.85 to 0.9. 0.8 keeps the obvious
 * cases automatic and leaves the hedged ones for a person. Override with
 * DEAD_LETTER_AUTO_REPLAY_MIN_CONFIDENCE.
 */
export const DEAD_LETTER_AUTO_REPLAY_MIN_CONFIDENCE = 0.8;

const TRIAGE_CRITERIA: Record<DeadLetterTriageReason, string> = {
  transient:
    "A one-off failure: timeout, connection reset, rate limit, 5xx from a destination that otherwise works, or Axel-side backpressure (axel_backpressure is true: the destination never saw the event). Replaying the same event later would very likely succeed. Few or no other failures share this fingerprint, and earlier replays of this fingerprint succeeded.",
  destination_down:
    "The destination is unreachable or failing for every event: DNS failure, connection refused, TLS failure, or repeated 5xx. Many failures share this fingerprint in the last hour and replays have not succeeded. Replaying now would fail again; wait for the destination to recover.",
  schema_mismatch:
    "The destination accepted the connection but rejected the row: unknown column, wrong type, missing required field, constraint violation, or table not found. A replay fails until the route transform or the destination schema changes.",
  bad_payload:
    "The event itself cannot be delivered: the raw payload is missing, not JSON, too large, or the spill object is gone. No replay can fix it.",
  auth_or_config:
    "Credentials or configuration are wrong: 401, 403, permission denied, invalid key, bucket or database not found, or the destination was disabled. A person must fix the setup before a replay can work.",
};

/**
 * Allowlisted dead_letters.reason slugs (mirrors the dashboard's AI prompt
 * privacy list). Anything else is sent as "other".
 */
const REASON_ALLOWLIST = new Set([
  "breaker_half_open_test_failed",
  "breaker_open_cooldown_active",
  "connector_failed",
  "declarative_engine_error",
  "delivery_dead",
  "delivery_overloaded",
  "delivery_paused",
  "delivery_service_503",
  "destination_disabled_manually",
  "destination_rejected",
  "half_open_probe_in_flight",
  "half_open_probe_timed_out",
  "max_retries_exceeded",
  "payload_missing",
  "rate_limited",
  "raw_payload_missing",
  "retry_after_window_active",
  "router_processing_failed",
  "spill_r2_key_missing",
]);

const DESTINATION_TYPE_ALLOWLIST = new Set([
  "bigquery",
  "databricks_sql",
  "databricks_volume",
  "http",
  "mongodb",
  "postgres",
  "r2",
  "s3",
  "webhook",
]);

/**
 * Reasons that mean Axel itself held the delivery back (capacity, breaker,
 * retry window). The destination never saw the event, so a replay usually
 * lands once the pressure clears.
 */
export const AXEL_BACKPRESSURE_REASONS: ReadonlySet<string> = new Set([
  "breaker_half_open_test_failed",
  "breaker_open_cooldown_active",
  "delivery_overloaded",
  "delivery_paused",
  "delivery_service_503",
  "half_open_probe_in_flight",
  "half_open_probe_timed_out",
  "rate_limited",
  "retry_after_window_active",
]);

/**
 * Reasons no replay can fix. The worker still triages them (so the inbox
 * shows a label) but never auto-replays.
 */
export const NON_REPLAYABLE_REASONS: ReadonlySet<string> = new Set([
  "payload_missing",
  "raw_payload_missing",
  "spill_r2_key_missing",
  "declarative_engine_error",
  "destination_disabled_manually",
]);

/**
 * Fixed vocabulary of signals extracted from the diagnostic. Only the token
 * names cross to Jev, never the matched text.
 */
const SIGNAL_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["timeout", /\b(timed? ?out|etimedout|deadline exceeded)\b/i],
  ["connection_refused", /\b(econnrefused|connection refused)\b/i],
  ["connection_reset", /\b(econnreset|socket hang up|connection reset|epipe)\b/i],
  ["dns_failure", /\b(enotfound|eai_again|getaddrinfo|could not resolve|name resolution)\b/i],
  ["tls_failure", /\b(tls|ssl|certificate|cert_|handshake)\b/i],
  ["rate_limited", /\b(rate limit|rate-limit|too many requests|throttl|quota)\b/i],
  ["circuit_breaker", /\b(breaker|circuit)\b/i],
  ["backpressure", /\b(shed|inflight|in-flight|overloaded|capacity)\b/i],
  ["unauthorized", /\b(unauthori[sz]ed|forbidden|permission denied|access denied|invalid (api )?key|invalid credentials|authentication|not authorized|signature)\b/i],
  ["not_found_resource", /\b(bucket|database|dataset|table|collection|relation|column|schema)\b[^.]{0,40}\b(not found|does not exist|doesn't exist|unknown)\b/i],
  ["unknown_column", /\b(unknown|no such|undefined) (column|field)\b|\bcolumn\b[^.]{0,60}\bdoes not exist\b/i],
  ["type_mismatch", /\b(invalid input syntax|type mismatch|cannot cast|could not convert|wrong type|expected [a-z]+ (but|got)|not a valid)\b/i],
  ["missing_required", /\b(null value|not-null|not null|required (field|property|column)|missing (field|column|required))\b/i],
  ["constraint_violation", /\b(constraint|duplicate key|unique violation|foreign key|check violation)\b/i],
  ["invalid_json", /\b(invalid json|unexpected token|json parse|malformed|not valid json)\b/i],
  ["payload_too_large", /\b(too large|payload size|413|entity too large|exceeds)\b/i],
  ["payload_missing", /\b(payload missing|raw payload|object not found|no such key|nosuchkey)\b/i],
  ["server_error", /\b(internal server error|bad gateway|service unavailable|gateway timeout)\b/i],
];

export interface DeadLetterTriageInput {
  /** dead_letters.reason as stored. */
  reason: string;
  /** dead_letters.message as stored. Read locally, never sent. */
  message: string;
  /** destinations.type, or null when unknown. */
  destination_type: string | null;
  /** Failures sharing this fingerprint in the last hour (this one included). */
  same_fingerprint_1h: number;
  /** Failures sharing this fingerprint in the last 24 hours. */
  same_fingerprint_24h: number;
  /** Dead letters with this fingerprint that a replay resolved in the last 24 hours. */
  replay_successes_24h: number;
  /** Replays of this fingerprint that failed in the last 24 hours. */
  replay_failures_24h: number;
  /** Minutes since the failure. */
  age_minutes: number;
}

/** What Jev sees. Exported so tests can assert nothing else leaks. */
export interface DeadLetterTriageState {
  failure_reason: string;
  /** True when Axel shed or paused the delivery before the destination saw it. */
  axel_backpressure: boolean;
  destination_type: string;
  http_status: number | null;
  signals: string[];
  same_fingerprint_1h: number;
  same_fingerprint_24h: number;
  replay_successes_24h: number;
  replay_failures_24h: number;
  age_minutes: number;
}

export interface DeadLetterTriageResult {
  reason: DeadLetterTriageReason;
  confidence: number;
  probabilities: Record<string, number>;
  /** The state that was sent, for audit. */
  state: DeadLetterTriageState;
}

export function buildDeadLetterTriageState(input: DeadLetterTriageInput): DeadLetterTriageState {
  const message = input.message ?? "";
  const signals: string[] = [];
  for (const [name, re] of SIGNAL_PATTERNS) {
    if (re.test(message)) signals.push(name);
  }
  return {
    failure_reason: REASON_ALLOWLIST.has(input.reason) ? input.reason : "other",
    axel_backpressure: AXEL_BACKPRESSURE_REASONS.has(input.reason),
    destination_type:
      input.destination_type && DESTINATION_TYPE_ALLOWLIST.has(input.destination_type)
        ? input.destination_type
        : "unknown",
    http_status: extractHttpStatus(message),
    signals,
    same_fingerprint_1h: clampCount(input.same_fingerprint_1h),
    same_fingerprint_24h: clampCount(input.same_fingerprint_24h),
    replay_successes_24h: clampCount(input.replay_successes_24h),
    replay_failures_24h: clampCount(input.replay_failures_24h),
    age_minutes: clampCount(input.age_minutes),
  };
}

export function buildDeadLetterTriageRequest(
  state: DeadLetterTriageState,
  config: JevInferenceConfig,
): {
  model: string;
  state: DeadLetterTriageState;
  questions: Record<string, { type: "choice"; instructions: string; criteria: Record<string, string> }>;
} {
  return {
    model: config.model ?? JEV_DEFAULT_MODEL,
    state,
    questions: {
      triage: {
        type: "choice",
        instructions:
          "A webhook delivery failed for good after retries. Given the failure reason slug, whether Axel itself held the delivery back (axel_backpressure), destination type, HTTP status, signal tokens found in the diagnostic, and how this fingerprint has behaved recently, why did it fail?",
        criteria: { ...TRIAGE_CRITERIA },
      },
    },
  };
}

/** Ask Jev. Throws `JevError` on any transport or shape problem. */
export async function triageDeadLetter(
  input: DeadLetterTriageInput,
  config: JevInferenceConfig,
): Promise<DeadLetterTriageResult> {
  const state = buildDeadLetterTriageState(input);
  const body = buildDeadLetterTriageRequest(state, config);
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
      controller.signal.aborted
        ? "request timed out"
        : `request failed: ${err instanceof Error ? err.message : String(err)}`,
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
  const answer = (parsed as { answers?: { triage?: unknown } } | null)?.answers?.triage as
    | { type?: unknown; choice?: unknown; confidence?: unknown; probabilities?: unknown }
    | undefined;
  if (
    !answer
    || answer.type !== "choice"
    || typeof answer.choice !== "string"
    || typeof answer.confidence !== "number"
    || !answer.probabilities
    || typeof answer.probabilities !== "object"
  ) {
    throw new JevError("response missing triage answer");
  }
  if (!(DEAD_LETTER_TRIAGE_REASONS as readonly string[]).includes(answer.choice)) {
    throw new JevError(`unknown triage reason ${answer.choice}`);
  }
  const probabilities: Record<string, number> = {};
  for (const [k, v] of Object.entries(answer.probabilities as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) probabilities[k] = v;
  }
  return {
    reason: answer.choice as DeadLetterTriageReason,
    confidence: Math.min(1, Math.max(0, answer.confidence)),
    probabilities,
    state,
  };
}

/**
 * The auto-replay rule, kept pure so it is easy to test and to read: replay
 * only a transient failure Jev is sure about, for a reason a replay can fix.
 */
export function shouldAutoReplay(
  triage: Pick<DeadLetterTriageResult, "reason" | "confidence">,
  deadLetterReason: string,
  minConfidence: number = DEAD_LETTER_AUTO_REPLAY_MIN_CONFIDENCE,
): boolean {
  if (triage.reason !== "transient") return false;
  if (triage.confidence < minConfidence) return false;
  if (NON_REPLAYABLE_REASONS.has(deadLetterReason)) return false;
  return true;
}

function extractHttpStatus(message: string): number | null {
  const m =
    /\b(?:http|status(?: code)?)[ :=/]*([1-5]\d{2})\b/i.exec(message)
    ?? /\b([1-5]\d{2}) (?:bad request|unauthorized|forbidden|not found|too many requests|unprocessable|internal server error|bad gateway|service unavailable|gateway timeout)\b/i.exec(message);
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return n >= 100 && n <= 599 ? n : null;
}

function clampCount(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1_000_000, Math.round(n));
}
