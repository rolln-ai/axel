import {
  assertResolvedHostSafe,
  validateDestinationUrl,
  type DnsLookupAll,
  type DeliveryAttempt,
  type Destination,
  type DestinationType,
  type RouteDestinationBinding,
} from "@axel/shared";
import { classifyDeliveryStatus } from "./classify.js";

export {
  createWebhookConnector,
  computeWebhookSignature,
  generateWebhookSecret,
  buildSignedWebhookRequest,
} from "./webhook.js";
export type {
  WebhookConnectorOptions,
  WebhookDestinationConfig,
  WebhookSigningAlgorithm,
} from "./webhook.js";
export { classifyDeliveryStatus } from "./classify.js";
export type { DeliveryOutcomeStatus } from "./classify.js";

export interface Connector<TConfig = unknown> {
  type: Destination["type"];
  deliver(
    event: ArrayBuffer,
    destination: Destination<TConfig>,
    context?: DeliveryContext,
  ): Promise<DeliveryAttempt>;
}

export interface DeliveryContext {
  eventId: string;
  workspaceId?: string;
  sourceId?: string;
  routeId?: string;
  receivedAt?: string;
  isTest?: boolean;
  /** AXE-28 — per-attempt timeout override (destination
   *  `request_timeout_ms` flows through here at dispatch time). */
  timeoutMs?: number;
  /**
   * Per-route binding from `route_destinations.binding`. Flows in
   * from the queue message. Connectors prefer this over the destination's
   * own `config` so a single destination can fan out to many targets via
   * separate routes (postgres table per route, mongo collection per
   * route, etc.). Null means legacy row — connector falls back to
   * `destination.config`.
   */
  binding?: RouteDestinationBinding | null;
}

export interface HttpDestinationConfig {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface R2DestinationConfig {
  bucket: string;
  keyPrefix?: string;
}

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
  /** AXE-28 — header bag, optional so existing fakes keep working.
   *  When present, the HTTP connector parses `Retry-After` so the
   *  delivery-service breaker can write `retry_after_until`. */
  headers?: { get(name: string): string | null };
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: ArrayBuffer;
    /** AXE-28 — request-timeout AbortController signal. Optional so
     *  the existing in-memory fakes don't have to wire AbortSignal. */
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

export interface ObjectStoreLike {
  put(key: string, value: ArrayBuffer, metadata: Record<string, string>): Promise<void>;
}

export const CONNECTORS_VERSION = "0.1.0-mvp";

export class DeliveryError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DeliveryError";
  }
}

/**
 * Runtime-shaped knobs for the HTTP connector. Everything that legitimately
 * differs between the Node delivery-service and the Cloudflare Worker lives
 * here (or is already injected as `fetchImpl` / `lookup`) — the request
 * building, signing, timeout plumbing and status classification are shared.
 *
 * Node-specific transport tuning (undici Agent, keep-alive, connection
 * pooling) is expressed by passing a bound `fetchImpl`; the connector never
 * reaches for a Node API itself.
 */
export interface HttpConnectorOptions {
  /**
   * Fallback request timeout when neither `context.timeoutMs` (per-attempt
   * override, sourced from `destinations.request_timeout_ms`) nor
   * `config.timeoutMs` is set.
   *
   * The Workers runtime passes 15_000: a Worker has a hard CPU/wall budget
   * and an unbounded fetch to a customer-controlled URL pins a delivery slot
   * until the platform kills the invocation. The Node service leaves this
   * undefined, which preserves its current "no implicit timeout" behaviour.
   */
  defaultTimeoutMs?: number;
}

/**
 * Build the exact request the HTTP connector puts on the wire. Pure — no I/O.
 * Exported so the cross-runtime golden-request contract test can assert both
 * runtimes emit byte-identical requests without going near a socket.
 */
export function buildHttpRequest(input: {
  config: HttpDestinationConfig;
  body: ArrayBuffer;
}): { url: string; method: string; headers: Record<string, string>; body: ArrayBuffer } {
  return {
    url: input.config.url,
    method: input.config.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...input.config.headers,
    },
    body: input.body,
  };
}

export function createHttpConnector(
  fetchImpl: FetchLike = missingFetch,
  lookup?: DnsLookupAll,
  options: HttpConnectorOptions = {},
): Connector<HttpDestinationConfig> {
  return {
    type: "http",
    async deliver(event, destination, context) {
      const started = Date.now();
      const config = destination.config;
      // AXE-34 — SSRF check before opening the socket. Catches
      // edited-after-save URL changes that bypassed dashboard
      // validation, and the metadata/private-IP families. Returns
      // an attempt with `dead` status so the queue stops retrying
      // (this is a permanent config error, not transient).
      const ssrfReason = validateDestinationUrl(config.url);
      if (ssrfReason) {
        return attempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          status: "dead",
          response: { error: `ssrf_blocked: ${ssrfReason}` },
          started,
        });
      }
      // Resolved-IP SSRF check (DNS-rebinding) — only when a resolver is
      // injected (Node delivery path). Skipped in runtimes without DNS access.
      if (lookup) {
        const resolvedReason = await assertResolvedHostSafe(new URL(config.url).hostname, lookup);
        if (resolvedReason) {
          return attempt({
            eventId: context?.eventId ?? "unknown",
            destinationId: destination.destination_id,
            status: "dead",
            response: { error: `ssrf_blocked: ${resolvedReason}` },
            started,
          });
        }
      }
      // AXE-28 — request timeout via AbortController. Destination
      // config + dynamic per-attempt override both flow through here,
      // with the runtime's `defaultTimeoutMs` as the final fallback.
      const timeoutMs = context?.timeoutMs ?? config.timeoutMs ?? options.defaultTimeoutMs;
      const ac = timeoutMs ? new AbortController() : null;
      const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
      try {
        const req = buildHttpRequest({ config, body: event });
        const response = await fetchImpl(req.url, {
          method: req.method,
          headers: req.headers,
          body: req.body,
          ...(ac ? { signal: ac.signal } : {}),
        });
        const responseText = await response.text();
        // AXE-28 — parse Retry-After so the breaker can pause future
        // attempts. Surfaced inside `response` so we don't need a new
        // top-level DeliveryAttempt field.
        const retryAfter = parseRetryAfterSeconds(response.headers?.get("retry-after"));
        return attempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          // One classifier for HTTP and webhook, both runtimes — see
          // ./classify.ts for the policy and why it changed.
          status: classifyDeliveryStatus(response.status),
          response: {
            status: response.status,
            body: responseText.slice(0, 2048),
            ...(retryAfter !== null ? { retry_after_seconds: retryAfter } : {}),
          },
          started,
        });
      } catch (err) {
        return attempt({
          eventId: context?.eventId ?? "unknown",
          destinationId: destination.destination_id,
          status: "retry",
          response: {
            error: err instanceof Error ? err.message : String(err),
          },
          started,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/**
 * Parse a `Retry-After` header value. The HTTP spec allows either
 * delta-seconds (integer) or HTTP-date — we accept both, returning
 * seconds-from-now. Returns null if the value is missing or
 * unparseable so the caller can fall back to its normal backoff.
 */
function parseRetryAfterSeconds(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const seconds = Math.ceil((date - Date.now()) / 1000);
    return seconds > 0 ? seconds : 0;
  }
  return null;
}

// Strip trailing "/" without a backtracking regex. `/\/+$/` is flagged
// js/polynomial-redos on operator-controlled key prefixes; a linear scan is
// equivalent and can't degrade.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return s.slice(0, end);
}

export function createR2Connector(store: ObjectStoreLike): Connector<R2DestinationConfig> {
  return {
    type: "r2",
    async deliver(event, destination, context) {
      const started = Date.now();
      // Route binding takes precedence: { key_prefix } overrides destination.config.keyPrefix.
      const binding = context?.binding as { key_prefix?: string } | null | undefined;
      const rawPrefix = binding?.key_prefix ?? destination.config.keyPrefix ?? "";
      const prefix = stripTrailingSlashes(rawPrefix);
      const key = `${prefix ? `${prefix}/` : ""}${destination.workspace_id}/${Date.now()}-${destination.destination_id}.json`;
      await store.put(key, event, {
        workspace_id: destination.workspace_id,
        destination_id: destination.destination_id,
      });
      return attempt({
        eventId: context?.eventId ?? "unknown",
        destinationId: destination.destination_id,
        status: "success",
        response: { bucket: destination.config.bucket, key },
        started,
      });
    },
  };
}

export function createUnsupportedConnector(type: Exclude<DestinationType, "http" | "r2" | "webhook">): Connector {
  return {
    type,
    async deliver(_event, destination, context) {
      return attempt({
        eventId: context?.eventId ?? "unknown",
        destinationId: destination.destination_id,
        status: "dead",
        response: {
          error: `${type} connector is not configured in this runtime`,
        },
        started: Date.now(),
      });
    },
  };
}

export function createConnectorRegistry(connectors: Connector[]): Map<DestinationType, Connector> {
  const registry = new Map<DestinationType, Connector>();
  for (const connector of connectors) {
    registry.set(connector.type, connector);
  }
  return registry;
}

function attempt(input: {
  eventId: string;
  destinationId: string;
  status: DeliveryAttempt["status"];
  response: unknown;
  started: number;
}): DeliveryAttempt {
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

async function missingFetch(): Promise<FetchResponseLike> {
  throw new DeliveryError("HTTP connector requires a fetch implementation", false);
}
