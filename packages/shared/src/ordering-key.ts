/**
 * FIFO / ordered-delivery key extraction (Phase 1).
 *
 * For sources that opt into ordered delivery, every accepted event gets an
 * `ordering_key` resolved at ingest from EITHER a configured header or a
 * dot-path into the JSON body. Same-key events are then co-located on one
 * shard (`shardFor(ordering_key)`) and — in later phases — serialized through
 * a per-key Durable Object so event N+1 is never delivered before N reaches a
 * terminal outcome.
 *
 * This module is the Phase-1 foundation: pure extraction, no behavior change.
 * It is DEFAULT-OFF. When `ordering_enabled` is false/undefined the resolver
 * returns null and the caller shards by `event_id` exactly as before — so the
 * emitted message and chosen shard are byte-identical to baseline.
 *
 * Design choices, mirrored from the FIFO design doc:
 *  - Header wins over path when both are configured and the header is present.
 *  - The key is extracted from the PRE-redaction body (the physical received
 *    payload), independent of any per-route field selection.
 *  - A missing header, missing/invalid path, non-JSON body, or non-scalar leaf
 *    yields null — the caller falls back to the unordered hot path. A missing
 *    key MUST NEVER drop an event.
 *  - The resolved key is namespaced `${workspace_id}:${source_id}:${raw}` so
 *    the same raw value on two different sources can never collide into one
 *    ordering stream.
 *  - The key is NOT the event_id: uuidv7 here has a fully random tail, so it is
 *    not a valid intra-millisecond sort key. Ordering is established later by
 *    enqueue order, not by comparing keys.
 *
 * Pure — runs in Workers, Node, and tests.
 */

export interface OrderingKeyConfig {
  workspace_id: string;
  source_id: string;
  ordering_enabled?: boolean;
  /** Header name (case-insensitive) whose value is the ordering key. */
  ordering_key_header?: string;
  /** Dot-path into the JSON body, e.g. "data.account.id". */
  ordering_key_path?: string;
}

/**
 * Resolve the namespaced ordering key for an event, or null when ordering is
 * disabled or no key could be extracted. `headers` keys are expected to be
 * lowercased (as the ingest worker's collectHeaders produces).
 */
export function resolveOrderingKey(
  source: OrderingKeyConfig,
  rawBody: Uint8Array,
  headers: Record<string, string>,
): string | null {
  if (!source.ordering_enabled) return null;

  let raw: string | null = null;

  const headerName = source.ordering_key_header?.trim().toLowerCase();
  if (headerName) {
    const value = headers[headerName];
    if (typeof value === "string" && value.length > 0) raw = value;
  }

  if (raw === null) {
    const path = source.ordering_key_path?.trim();
    if (path) raw = extractScalarAtPath(rawBody, path);
  }

  if (raw === null) return null;
  return `${source.workspace_id}:${source.source_id}:${raw}`;
}

/**
 * Walk a dot-path to a scalar leaf in a JSON body. Returns the leaf as a
 * string (numbers/booleans stringified) or null if the body isn't JSON, the
 * path doesn't resolve, or the leaf isn't a non-empty scalar. No `[]` array
 * descent: an ordering key must be a single deterministic value, so a path
 * that lands on an array or object yields null.
 */
function extractScalarAtPath(bytes: Uint8Array, path: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null; // not JSON — no key
  }

  const segments = path
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  let node: unknown = parsed;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[segment];
  }

  if (typeof node === "string") return node.length > 0 ? node : null;
  if (typeof node === "number") return Number.isFinite(node) ? String(node) : null;
  if (typeof node === "boolean") return String(node);
  return null; // object, array, null, undefined — not a usable key
}
