import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";

const REDACTED = "[REDACTED]";

const SAFE_COMPONENTS = new Set([
  "billing_checkout",
  "billing_checkout_return",
  "billing_portal",
  "billing_rollup_cron",
  "data_contracts_auto_draft_cron",
  "data_contracts_drift_cron",
  "edge_cache_sync",
  "notification_scan_cron",
  "notifications_digest_cron",
  "nudges_cron",
  "operational_alert",
  "ops_sentry_source_map",
  "ops_sentry_transport",
  "redact_fixtures_backfill",
  "stripe_webhook",
  "workspace_teardown_cron",
]);

const SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "codeverifier",
  "cookie",
  "credential",
  "credentials",
  "idtoken",
  "invite",
  "invitetoken",
  "jwt",
  "password",
  "privatekey",
  "query",
  "querystring",
  "refreshtoken",
  "searchparams",
  "setcookie",
  "signature",
  "signingsecret",
  "token",
  "xaxeltoken",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    /(?:apikey|authorization|cookie|credential|password|privatekey|secret|signature|token)/.test(
      normalized,
    )
  );
}

function isUrlKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    normalized === "from" ||
    normalized === "to" ||
    normalized === "href" ||
    normalized === "location" ||
    normalized.endsWith("url") ||
    normalized.includes("referrer") ||
    normalized.includes("referer")
  );
}

function looksLikeUrl(value: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(value) || value.startsWith("/");
}

const EMBEDDED_ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;
const EMBEDDED_RELATIVE_URL =
  /(^|[\s("'=])((?:\/|\.\.?\/)[^\s<>"']*[?#][^\s<>"']*)/g;
const SENSITIVE_QUERY_VALUE =
  /([?&#;](?:access[_-]?token|api[_-]?key|auth(?:orization)?|client[_-]?secret|code|credential|id[_-]?token|invite|jwt|key|password|refresh[_-]?token|secret|session(?:[_-]?id)?|sig(?:nature)?|token)=)[^&#;\s<>"']*/gi;
const ENCODED_SENSITIVE_QUERY_VALUE =
  /((?:^|%3f|%26|%23)(?:access(?:_|%5f|-)?token|api(?:_|%5f|-)?key|auth(?:orization)?|client(?:_|%5f|-)?secret|code|credential|id(?:_|%5f|-)?token|invite|jwt|key|password|refresh(?:_|%5f|-)?token|secret|session(?:(?:_|%5f|-)?id)?|sig(?:nature)?|token)(?:=|%3d))(?:(?!%26|%23|\s).)*/gi;

/**
 * Analytics and error reporting do not need query strings or fragments. Drop
 * both wholesale instead of trying to maintain an inevitably incomplete list
 * of credential parameter names.
 */
export function sanitizeTelemetryUrl(value: string): string {
  const delimiters = [value.indexOf("?"), value.indexOf("#")].filter(
    (index) => index >= 0,
  );
  const encodedDelimiter = value.search(/%3f|%23/i);
  if (encodedDelimiter >= 0) delimiters.push(encodedDelimiter);
  return delimiters.length > 0 ? value.slice(0, Math.min(...delimiters)) : value;
}

function sanitizeString(value: string, key: string | undefined): string {
  let sanitized = value;
  if ((key && isUrlKey(key)) || looksLikeUrl(value)) {
    sanitized = sanitizeTelemetryUrl(value);
  }
  sanitized = sanitized.replace(EMBEDDED_ABSOLUTE_URL, (url) =>
    sanitizeTelemetryUrl(url),
  );
  sanitized = sanitized.replace(
    EMBEDDED_RELATIVE_URL,
    (_match, prefix: string, url: string) => `${prefix}${sanitizeTelemetryUrl(url)}`,
  );
  sanitized = sanitized.replace(SENSITIVE_QUERY_VALUE, "$1[REDACTED]");
  sanitized = sanitized.replace(
    ENCODED_SENSITIVE_QUERY_VALUE,
    "$1%5BREDACTED%5D",
  );
  if (key === "component" && SAFE_COMPONENTS.has(sanitized)) return sanitized;
  if (key === "phase" && sanitized === "job") return sanitized;
  return sanitizeConnectorDiagnosticForStorage(sanitized, 4000);
}

/**
 * Return a telemetry-safe copy while preserving non-plain values such as Date.
 * Credential-shaped properties are redacted at any depth, and every URL loses
 * its query string and fragment.
 */
export function sanitizeTelemetryValue<T>(value: T): T {
  const seen = new WeakMap<object, unknown>();

  function visit(current: unknown, key?: string): unknown {
    if (key && isSensitiveKey(key)) return REDACTED;
    if (typeof current === "string") return sanitizeString(current, key);
    if (current === null || typeof current !== "object") return current;
    if (current instanceof Date) return current;

    const existing = seen.get(current);
    if (existing) return existing;

    if (Array.isArray(current)) {
      const copy: unknown[] = [];
      seen.set(current, copy);
      for (const item of current) copy.push(visit(item));
      return copy;
    }

    const copy: Record<string, unknown> = {};
    seen.set(current, copy);
    for (const [property, propertyValue] of Object.entries(current)) {
      copy[property] = visit(propertyValue, property);
    }
    return copy;
  }

  return visit(value) as T;
}
