import type { DestinationQueueMessage } from "./types.js";

/**
 * Cloudflare Queues caps a single message body at 128KB. We spill the
 * heavy fields (`payload`, `headers`, `query`) to R2 once the serialised
 * message gets close — leaving headroom for the metadata around it and
 * the queue's own envelope.
 *
 * 100KB is intentionally conservative: a transformed payload near the
 * limit plus large `headers`/`query` could push the JSON envelope and
 * Cloudflare's wrapping over 128KB on its own, and a few KB of
 * accounting metadata (binding, idempotency_key, …) sits in the message
 * regardless. If we ever see false-positive spills in production we can
 * raise this; false negatives (no spill, queue 413) are the failure
 * mode this whole module exists to prevent.
 */
export const QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES = 100 * 1024;

/**
 * R2 prefix used for spill objects. Kept under a single namespace so
 * lifecycle rules / audits can target spill keys distinctly from raw
 * event payloads (which live elsewhere in the same bucket today).
 */
export const QUEUE_SPILL_KEY_PREFIX = "queue-spill";

export interface QueueSpillBody {
  payload: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
}

/**
 * Minimal R2 writer surface. The CF Worker binding implements `.put`
 * directly; the Node-side replay worker wraps Cloudflare's R2 HTTP
 * API. Either way, the producer only needs PUT.
 */
export interface QueueSpillWriter {
  put(key: string, body: string): Promise<void>;
}

/**
 * Minimal R2 reader+deleter surface used by the delivery consumer.
 * Delete is best-effort and only fires on terminal outcomes — a leaked
 * spill key costs R2 storage but doesn't break correctness.
 */
export interface QueueSpillReader {
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
}

export class QueueSpillObjectMissingError extends Error {
  readonly spillKey: string;

  constructor(spillKey: string) {
    super(`spill_r2_key_missing: ${spillKey}`);
    this.name = "QueueSpillObjectMissingError";
    this.spillKey = spillKey;
  }
}

export function isQueueSpillObjectMissingError(err: unknown): err is QueueSpillObjectMissingError {
  return err instanceof QueueSpillObjectMissingError
    || (err instanceof Error && err.message.startsWith("spill_r2_key_missing: "));
}

/**
 * The wire message referenced a spill object that does not belong to that
 * exact delivery attempt. Reject this before touching R2: queue messages are
 * data, not authority to read another workspace's object key.
 */
export class QueueSpillKeyMismatchError extends Error {
  readonly spillKey: string;
  readonly expectedSpillKey: string;

  constructor(spillKey: string, expectedSpillKey: string) {
    // Keep attacker-controlled key material out of logs and Sentry titles.
    super("spill_r2_key_mismatch");
    this.name = "QueueSpillKeyMismatchError";
    this.spillKey = spillKey;
    this.expectedSpillKey = expectedSpillKey;
  }
}

/**
 * The spill object came back but didn't parse as JSON.
 *
 * Raised instead of the bare `SyntaxError` from `JSON.parse` so the error
 * carries the spill key and body size rather than a byte offset. A raw
 * SyntaxError fingerprints on "position <n>", which opens a fresh Sentry
 * issue per truncation length (JAVASCRIPT-3M) and buries the one fact that
 * identifies the object.
 */
export class QueueSpillBodyCorruptError extends Error {
  readonly spillKey: string;
  readonly byteLength: number;

  constructor(spillKey: string, byteLength: number) {
    super(`spill_r2_body_corrupt: ${spillKey} (${byteLength} bytes)`);
    this.name = "QueueSpillBodyCorruptError";
    this.spillKey = spillKey;
    this.byteLength = byteLength;
  }
}

export function isQueueSpillBodyCorruptError(err: unknown): err is QueueSpillBodyCorruptError {
  return err instanceof QueueSpillBodyCorruptError
    || (err instanceof Error && err.message.startsWith("spill_r2_body_corrupt: "));
}

/**
 * Build a stable spill key for a given delivery attempt. Keying on
 * attempt_no means a replay (which bumps attempt_no) writes to a fresh
 * key instead of overwriting an in-flight retry's spill.
 */
export function buildSpillKey(message: DestinationQueueMessage): string {
  return [
    QUEUE_SPILL_KEY_PREFIX,
    message.workspace_id,
    message.event_id,
    message.destination_id,
    `${message.attempt_no}.json`,
  ].join("/");
}

/**
 * Return true only when the referenced spill key belongs to this exact
 * delivery attempt. This predicate performs no I/O and is suitable for
 * guarding reads and best-effort deletes alike.
 */
export function hasCanonicalSpillKey(message: DestinationQueueMessage): boolean {
  return typeof message.spill_r2_key === "string"
    && message.spill_r2_key === buildSpillKey(message);
}

/**
 * Prepare a message for enqueue:
 *
 *  - If `spill_r2_key` is already set and canonical, the message has been
 *    through a spill round-trip without changing attempts. The R2 object is
 *    still authoritative — strip the inline copies and return the wire form.
 *  - If the attempt changed, write the hydrated fields under the new attempt's
 *    canonical key before stripping them. This keeps retries compatible with
 *    exact key binding instead of carrying `/1.json` into attempt 2.
 *  - Otherwise, measure the message's JSON byte size. If it exceeds
 *    the spill threshold, write `{ payload, headers, query }` to R2
 *    and return a stripped copy with `spill_r2_key` set. Small
 *    messages pass through unchanged.
 *
 * Throws if the R2 write fails — the caller should propagate so the
 * source queue retries instead of enqueueing a half-spilled message.
 */
export async function spillIfOversized(
  message: DestinationQueueMessage,
  writer: QueueSpillWriter,
): Promise<DestinationQueueMessage> {
  if (hasCanonicalSpillKey(message)) {
    return {
      ...message,
      payload: null,
      headers: {},
      query: {},
    };
  }
  if (message.spill_r2_key) {
    const spillKey = buildSpillKey(message);
    const spillBody: QueueSpillBody = {
      payload: message.payload,
      headers: message.headers,
      query: message.query,
    };
    await writer.put(spillKey, JSON.stringify(spillBody));
    return {
      ...message,
      payload: null,
      headers: {},
      query: {},
      spill_r2_key: spillKey,
    };
  }
  const serialised = JSON.stringify(message);
  if (byteLength(serialised) <= QUEUE_MESSAGE_SPILL_THRESHOLD_BYTES) {
    return message;
  }
  const spillKey = buildSpillKey(message);
  const spillBody: QueueSpillBody = {
    payload: message.payload,
    headers: message.headers,
    query: message.query,
  };
  await writer.put(spillKey, JSON.stringify(spillBody));
  return {
    ...message,
    payload: null,
    headers: {},
    query: {},
    spill_r2_key: spillKey,
  };
}

/**
 * If the message references an R2 spill, fetch and merge it back in.
 * Returns the message unchanged when there's no spill key.
 *
 * Throws QueueSpillObjectMissingError if the key is missing — that means the
 * spill was deleted before the consumer ran (a cleanup-vs-redelivery race).
 * Callers should surface that as a terminal delivery failure rather than
 * retrying forever or delivering an empty payload.
 *
 * Throws QueueSpillKeyMismatchError before any storage read if the supplied
 * key is not the canonical key for this exact workspace, event, destination,
 * and attempt.
 *
 * Throws QueueSpillBodyCorruptError if the object is present but unparseable
 * or does not match the `{ payload, headers, query }` contract. That one is
 * worth a retry — the reader rejects short bodies before we get here, so a
 * corrupt body that survives the retries is a real problem and should reach
 * Sentry.
 */
export async function hydrateIfSpilled(
  message: DestinationQueueMessage,
  reader: QueueSpillReader,
): Promise<DestinationQueueMessage> {
  if (!message.spill_r2_key) return message;
  const spillKey = message.spill_r2_key;
  const expectedSpillKey = buildSpillKey(message);
  if (!hasCanonicalSpillKey(message)) {
    throw new QueueSpillKeyMismatchError(spillKey, expectedSpillKey);
  }
  const buf = await reader.get(spillKey);
  if (!buf) {
    throw new QueueSpillObjectMissingError(spillKey);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(buf)) as unknown;
  } catch {
    // JSON.parse may quote the malformed input in its SyntaxError. Spill bodies
    // contain webhook payloads, so keep only non-sensitive key/size context.
    throw new QueueSpillBodyCorruptError(spillKey, buf.byteLength);
  }
  if (!isQueueSpillBody(parsed)) {
    throw new QueueSpillBodyCorruptError(spillKey, buf.byteLength);
  }
  return {
    ...message,
    payload: parsed.payload,
    headers: parsed.headers,
    query: parsed.query,
  };
}

/**
 * Best-effort cleanup. Non-canonical keys are ignored before storage access,
 * and errors are swallowed — a stuck delete shouldn't fail an otherwise-
 * successful delivery. Lifecycle rules on the R2 bucket should sweep
 * stragglers.
 */
export async function deleteSpillIfPresent(
  message: DestinationQueueMessage,
  reader: Pick<QueueSpillReader, "delete">,
): Promise<void> {
  if (!message.spill_r2_key) return;
  if (!hasCanonicalSpillKey(message)) return;
  try {
    await reader.delete(message.spill_r2_key);
  } catch {
    // Intentionally swallowed.
  }
}

function byteLength(s: string): number {
  // TextEncoder.encode allocates; for size-only we can use the cheaper
  // utf-8 byte-count formula. Falls back to TextEncoder when available
  // (Node 20+, Workers, browsers — i.e. always, in this codebase).
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(s).length;
  }
  // Defensive fallback: count UTF-8 bytes by hand.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function isQueueSpillBody(value: unknown): value is QueueSpillBody {
  if (!isRecord(value) || !Object.hasOwn(value, "payload")) return false;
  return isStringRecord(value.headers) && isStringRecord(value.query);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
