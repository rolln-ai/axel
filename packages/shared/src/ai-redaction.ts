import { maskPiiInText } from "./pii-mask.js";

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
const MAX_KEYS = 100;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 5_000;
const MAX_PROMPT_LENGTH = 64_000;

const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/gi;
const HEADER_VALUE_RE =
  /\b((?:proxy-)?authorization|(?:set-)?cookie|x-api-key|api-key)\s*[:=]\s*[^\r\n]*/gi;
const SECRET_HEADER_VALUE_RE =
  /\b([A-Za-z0-9_-]*(?:auth|authorization|cookie|token|key|signature|secret)[A-Za-z0-9_-]*)\s*:\s*[^\r\n]*/gi;
const SECRET_ASSIGNMENT_RE =
  /(["']?(?:password|passwd|pwd|passphrase|client[_-]?secret|webhook[_-]?secret|signing[_-]?secret|api[_-]?key|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?(?:id|token)|private[_-]?key|authorization|cookie|credentials?|token|secret|signature)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^,\s;&}]+)/gi;
const AUTH_VALUE_RE = /\b(Bearer|Basic|Digest)\s+[^\s,;]+/gi;
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi;
const URL_QUERY_VALUE_RE = /([?&#][A-Za-z0-9_.~-]{1,128}=)[^&#\s"'},\]]*/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const KNOWN_TOKEN_RE =
  /\b(?:axe_pat|whsec|github_pat|gh[pousr])_[A-Za-z0-9_-]{8,}\b/gi;
const STRIPE_TOKEN_RE = /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9_-]{8,}\b/gi;
const OPENAI_TOKEN_RE = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/gi;
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{30,}\b/g;
const AWS_ACCESS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const SENDGRID_TOKEN_RE = /\bSG\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const SIGNATURE_VALUE_RE = /\b(sha(?:1|256|512)|v1)=([A-Fa-f0-9]{16,})\b/g;
const OPAQUE_TOKEN_RE = /[A-Za-z0-9+/_=-]{32,}/g;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_GLOBAL_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;

const SECRET_KEY_TOKENS = new Set([
  "auth",
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "jwt",
  "passphrase",
  "passwd",
  "password",
  "pwd",
  "secret",
  "signature",
  "token",
]);

/**
 * True when a webhook property name normally carries authentication material.
 * This deliberately favors false positives over sending one credential to an
 * external model. Callers still retain the property name and surrounding shape.
 */
export function isSecretLikeWebhookKey(key: string): boolean {
  return key
    .replace(/\[\]/g, "")
    .split(".")
    .some(isSecretLikeKeySegment);
}

/** Treat every leaf inside a webhook-supplied header map as sensitive. */
export function isWebhookHeaderContainerKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  return ["headers", "http_headers", "request_headers", "response_headers"].includes(
    normalized,
  );
}

function isSecretLikeKeySegment(segment: string): boolean {
  const tokens = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (tokens.some((token) => SECRET_KEY_TOKENS.has(token))) return true;
  const joined = tokens.join("_");
  return /(?:^|_)(?:api|access|private|secret)_key(?:_|$)/.test(joined);
}

/**
 * Redact credentials, opaque tokens, and common PII from free text before it
 * crosses a third-party AI boundary. Redaction runs before the output cap so a
 * long credential cannot be made visible by truncating it below a detector's
 * minimum length.
 */
export function redactSecretLikeText(input: string): string {
  return redactText(input, MAX_STRING_LENGTH);
}

/** Apply the same rules to a complete prompt without the per-value 5KB cap. */
export function redactAiPrompt(input: string): string {
  return redactText(input, MAX_PROMPT_LENGTH);
}

function redactText(input: string, maxLength: number): string {
  if (!input) return input;
  let output = input
    .replace(PRIVATE_KEY_BLOCK_RE, REDACTED)
    // URI userinfo must be removed before email masking. A password followed
    // by an at-sign and hostname otherwise looks like an email and can leave
    // the username behind.
    .replace(URL_USERINFO_RE, "$1[REDACTED]@")
    .replace(HEADER_VALUE_RE, "$1: [REDACTED]")
    .replace(SECRET_HEADER_VALUE_RE, "$1: [REDACTED]")
    .replace(SECRET_ASSIGNMENT_RE, "$1[REDACTED]")
    .replace(AUTH_VALUE_RE, "$1 [REDACTED]")
    .replace(URL_QUERY_VALUE_RE, "$1[REDACTED]")
    .replace(JWT_RE, REDACTED)
    .replace(KNOWN_TOKEN_RE, REDACTED)
    .replace(STRIPE_TOKEN_RE, REDACTED)
    .replace(OPENAI_TOKEN_RE, REDACTED)
    .replace(SLACK_TOKEN_RE, REDACTED)
    .replace(GOOGLE_API_KEY_RE, REDACTED)
    .replace(AWS_ACCESS_KEY_RE, REDACTED)
    .replace(SENDGRID_TOKEN_RE, REDACTED)
    .replace(SIGNATURE_VALUE_RE, "$1=[REDACTED]");

  // Keep UUID event IDs useful in diagnostics. The general PII masker treats
  // their final 12-digit segment as an account number, and the opaque-token
  // rule treats the whole UUID as a credential-shaped value.
  const uuids: string[] = [];
  output = output.replace(UUID_GLOBAL_RE, (uuid) => {
    const marker = `__AXEL_UUID_MARKER_${uuids.length}__`;
    uuids.push(uuid);
    return marker;
  });
  output = maskPiiInText(output).replace(OPAQUE_TOKEN_RE, redactOpaqueToken);
  output = output.replace(/__AXEL_UUID_MARKER_(\d+)__/g, (_marker, index: string) => {
    return uuids[Number(index)] ?? "[REDACTED]";
  });
  return output.slice(0, maxLength);
}

/**
 * Copy a parsed webhook value into a bounded, prompt-safe representation.
 * Secret-bearing property values are removed even when the value itself is a
 * short ordinary word that no value-only detector could recognize.
 */
export function redactWebhookDataForAi(value: unknown): unknown {
  return redactWebhookValue(value, 0, new WeakSet<object>(), false);
}

function redactWebhookValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
  secretContainer: boolean,
): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean") return secretContainer ? REDACTED : value;
  if (typeof value === "string") {
    return secretContainer ? REDACTED : redactSecretLikeText(value);
  }
  if (typeof value === "number") {
    if (secretContainer) return REDACTED;
    if (Number.isInteger(value) && String(Math.abs(value)).length >= 8) return REDACTED;
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value !== "object") return "[UNSUPPORTED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactWebhookValue(item, depth + 1, seen, secretContainer));
  }

  const redacted: Record<string, unknown> = {};
  for (const [rawKey, child] of Object.entries(value as Record<string, unknown>).slice(
    0,
    MAX_KEYS,
  )) {
    const key = redactSecretLikeText(rawKey).slice(0, 200);
    redacted[key] = isSecretLikeWebhookKey(rawKey)
      ? REDACTED
      : redactWebhookValue(
          child,
          depth + 1,
          seen,
          secretContainer || isWebhookHeaderContainerKey(rawKey),
        );
  }
  return redacted;
}

function redactOpaqueToken(candidate: string): string {
  if (UUID_RE.test(candidate)) return candidate;
  if (/^[A-Fa-f0-9]{32,}$/.test(candidate)) return REDACTED;
  const classes = [
    /[a-z]/.test(candidate),
    /[A-Z]/.test(candidate),
    /\d/.test(candidate),
    /[+/_=-]/.test(candidate),
  ].filter(Boolean).length;
  const uniqueCharacters = new Set(candidate.toLowerCase()).size;
  return candidate.length >= 48 || classes >= 3 || uniqueCharacters >= 12
    ? REDACTED
    : candidate;
}
