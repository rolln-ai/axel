/**
 * Canonical event-type extraction, shared by the ingest worker (which
 * indexes the type into the ClickHouse `events.event_type` column at write
 * time) and the dashboard's Data Contract inference (which clusters samples
 * by type). Keeping a single implementation here guarantees the indexed
 * column and the inference agree on what "the event type" of a payload is —
 * otherwise a `SELECT DISTINCT event_type` would surface names the
 * inference never produces, and vice-versa.
 *
 * The heuristic: look at the top-level object for the first present key in
 * priority order whose value is a short string. This matches the shapes the
 * vast majority of webhook providers use (`type`, `event`, `event_type`,
 * `action`, `topic`, `name`), e.g. Stripe `{type:"payment_intent.succeeded"}`
 * or newsletter provider `{event:"subscriber.opened_email"}`.
 *
 * When the body carries no discriminator, we fall back to a small set of
 * common event-type HEADERS — many providers put the type only in a header
 * (GitHub `X-GitHub-Event`, Shopify `X-Shopify-Topic`, CloudEvents `ce-type`).
 */

/** Keys checked, in order, for the event-type discriminator. */
export const EVENT_TYPE_KEY_PRIORITY = [
  "type",
  "event",
  "event_type",
  "action",
  "topic",
  "name",
] as const;

/**
 * Header names (lowercase) checked, in order, when the body has no
 * discriminator. Body always wins; these are a fallback.
 */
export const EVENT_TYPE_HEADER_PRIORITY = [
  "x-event-type",
  "x-event-name",
  "x-event",
  "x-webhook-event",
  "x-github-event",
  "x-shopify-topic",
  "x-svix-event-type",
  "ce-type",
] as const;

/** Upper bound on a value we'll treat as a type name (guards against a free-text `name` field). Inclusive: a value of exactly this many characters is still accepted. */
const MAX_EVENT_TYPE_LEN = 80;

/**
 * Non-empty and at most {@link MAX_EVENT_TYPE_LEN} Unicode CODEPOINTS.
 *
 * JS `.length` counts UTF-16 code units, and astral-plane characters (emoji
 * etc.) take two units each — so a legitimately short discriminator built
 * from such characters could exceed 80 units and be silently dropped into
 * the untyped '' bucket. Count codepoints instead. This runs on the ingest
 * hot path, so only spread into codepoints when the cheap unit count is
 * ambiguous: <= MAX units always fits, > 2×MAX units never can.
 */
function isAcceptableTypeName(v: string): boolean {
  if (v.length === 0) return false;
  if (v.length <= MAX_EVENT_TYPE_LEN) return true;
  if (v.length > MAX_EVENT_TYPE_LEN * 2) return false;
  return [...v].length <= MAX_EVENT_TYPE_LEN;
}

/**
 * Extract the event type from an already-parsed payload value. Returns the
 * type string, or null when the payload isn't a plain object or carries no
 * recognizable discriminator.
 */
export function extractEventTypeFromValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  for (const key of EVENT_TYPE_KEY_PRIORITY) {
    const v = obj[key];
    if (typeof v === "string" && isAcceptableTypeName(v)) {
      return v;
    }
  }
  return null;
}

/**
 * Extract the event type from request headers, checking
 * {@link EVENT_TYPE_HEADER_PRIORITY} in order. Lookup is case-insensitive.
 * Returns null when no recognised header carries a short non-empty value.
 */
export function extractEventTypeFromHeaders(
  headers: Record<string, string> | null | undefined,
): string | null {
  if (!headers) return null;
  let lower: Record<string, string> | null = null;
  const get = (name: string): string | undefined => {
    const direct = headers[name];
    if (typeof direct === "string") return direct;
    if (!lower) {
      lower = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === "string") lower[k.toLowerCase()] = v;
      }
    }
    return lower[name];
  };
  for (const name of EVENT_TYPE_HEADER_PRIORITY) {
    const v = get(name);
    if (typeof v === "string" && isAcceptableTypeName(v)) {
      return v;
    }
  }
  return null;
}

/**
 * Extract the event type from a raw request body, falling back to common
 * event-type headers when the body has no discriminator. Parses JSON
 * best-effort. Returns `""` (not null) when neither body nor headers yield a
 * type, because the ClickHouse column is `LowCardinality(String) DEFAULT ''` —
 * an empty string is the canonical "unknown / untyped" marker and keeps the
 * column non-nullable. Never throws; this runs on the ingest hot path.
 */
export function extractEventTypeFromBody(
  bytes: Uint8Array,
  headers?: Record<string, string> | null,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    parsed = undefined;
  }
  return (
    extractEventTypeFromValue(parsed) ?? extractEventTypeFromHeaders(headers) ?? ""
  );
}
