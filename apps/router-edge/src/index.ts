/**
 * Axel router — Cloudflare Worker that consumes the 16 axel-events-* queues,
 * looks up active routes for each event's source, and fans out destination
 * messages onto the edge or native delivery queue.
 *
 * Route lookups go via HTTP to apps/delivery-service (`/internal/routes`),
 * not directly against Postgres. CF Workers can't reach Render Postgres —
 * Render's network blocks CF egress IPs even with `0.0.0.0/0` in the
 * Postgres IP rules — so the SQL runs on the Render side and the result
 * comes back as JSON.
 *
 * What this worker does NOT do (deliberately):
 *   - Eval-based filter/transform — the declarative engine
 *     (packages/shared/src/route-engine.ts) is the only filter/transform
 *     runtime. Migration 0009 (AXE-24) backfilled engine='declarative'
 *     for all routes and added a CHECK constraint preventing the broken
 *     "filter/transform on legacy_js" combination from being reintroduced.
 *   - ClickHouse logging of route_evaluations — TODO once logging is wired.
 *   - Replay processing — owned by a separate periodic runner, not the queue
 *     consumer hot path.
 *
 * Bindings (see wrangler.toml):
 *   - QUEUE_EVENTS_00..15 (consumer)
 *   - DELIVERY_QUEUE (producer)
 *   - DELIVERY_NATIVE_QUEUE (producer)
 *   - DEAD_LETTER_QUEUE (producer)
 *   - DELIVERY_SERVICE_URL (var) + DELIVERY_SHARED_SECRET (secret)
 */

import {
  type DestinationQueueMessage,
  type QueueMessage,
  type QueueSpillWriter,
  type Route,
  evaluateRouteFanout,
  isCanonicalRawPayloadKey,
  sleep,
  spillIfOversized,
  createTtlCache,
  requiresNativeRuntimeDestination,
  isParquetObjectStoreBinding,
  readBoundedJsonResponse,
  resolveInternalServiceEndpoint,
  sanitizeConnectorDiagnosticForStorage,
  validateInternalServiceEndpoint,
} from "@axel/shared";
import { captureException, isCloudflareQueueOverloadError, isTransientR2Error, recordHeartbeatHttp, sentryClientFromEnv, type SentryEnv } from "@axel/observability";

// FIFO/ordered delivery (Phase 2). The Durable Object class must be exported
// from the worker entry for wrangler to bind it. Scaffold — not yet called;
// see ordering/README.md for the call-site wiring plan.
export { OrderingDurableObject } from "./ordering/durable-object";

export interface Env extends SentryEnv {
  // Inbound: 16 sharded queues. We register one consumer entry per shard in
  // wrangler.toml so the runtime delivers messages here.
  QUEUE_EVENTS_00: Queue<unknown>;
  QUEUE_EVENTS_01: Queue<unknown>;
  QUEUE_EVENTS_02: Queue<unknown>;
  QUEUE_EVENTS_03: Queue<unknown>;
  QUEUE_EVENTS_04: Queue<unknown>;
  QUEUE_EVENTS_05: Queue<unknown>;
  QUEUE_EVENTS_06: Queue<unknown>;
  QUEUE_EVENTS_07: Queue<unknown>;
  QUEUE_EVENTS_08: Queue<unknown>;
  QUEUE_EVENTS_09: Queue<unknown>;
  QUEUE_EVENTS_10: Queue<unknown>;
  QUEUE_EVENTS_11: Queue<unknown>;
  QUEUE_EVENTS_12: Queue<unknown>;
  QUEUE_EVENTS_13: Queue<unknown>;
  QUEUE_EVENTS_14: Queue<unknown>;
  QUEUE_EVENTS_15: Queue<unknown>;
  // Outbound, two queues split by required runtime:
  //   DELIVERY_QUEUE        → CF delivery-edge worker (HTTP, R2, S3-via-aws4fetch)
  //   DELIVERY_NATIVE_QUEUE → Render Node service (Postgres, MongoDB, Databricks)
  // The router queries each destination's `type` from Postgres and routes
  // accordingly so customers don't need to think about the split.
  DELIVERY_QUEUE: Queue<DestinationQueueMessage>;
  DELIVERY_NATIVE_QUEUE: Queue<DestinationQueueMessage>;
  //   DELIVERY_PARQUET_QUEUE → optional, dedicated single-instance Parquet-S3
  //   consumer (Render worker role). Absent until the queue is provisioned;
  //   routing falls back to DELIVERY_NATIVE_QUEUE in that case.
  DELIVERY_PARQUET_QUEUE?: Queue<DestinationQueueMessage>;
  DEAD_LETTER_QUEUE: Queue<DeadLetterPayload>;
  // R2 bucket holding raw event payloads (for transform/filter eval).
  EVENTS_RAW: R2Bucket;
  // The delivery service hosts /internal/routes — used here for route lookups
  // because CF Workers can't reach Render Postgres directly (Render's network
  // blocks CF egress IPs even with `0.0.0.0/0` in the IP rules). Native
  // delivery itself goes through DELIVERY_NATIVE_QUEUE, not synchronous HTTP.
  DELIVERY_SERVICE_URL?: string;
  DELIVERY_SHARED_SECRET?: string;
  /** Heartbeat ingress on delivery-service. Defaults to
   *  `${DELIVERY_SERVICE_URL}/internal/heartbeat` when set. */
  DELIVERY_HEARTBEAT_URL?: string;
}

const ROUTER_CONSUMER_MAX_RETRIES = 3;
const R2_READ_RETRY_ATTEMPTS = 5;
const R2_READ_RETRY_BASE_DELAY_MS = 250;

interface DeadLetterPayload {
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  // Set only when the failure was for a specific destination (per-destination
  // dispatch). Route-level failures (raw payload missing, declarative-engine
  // error) and pre-routing failures leave this absent — there's no single
  // destination to blame. Persisted to dead_letters.destination_id (0049).
  destination_id?: string;
  r2_key: string;
  reason: string;
  message: string;
  errored_at: string;
}

// Carries route + destination context out of the per-destination enqueue loop
// so the catch-all (deadLetterRouterFailure) can record WHICH route and
// destination a failure was for, instead of an empty route_id.
class DeliveryDispatchError extends Error {
  readonly route_id: string;
  readonly destination_id: string;
  constructor(message: string, route_id: string, destination_id: string) {
    super(message);
    this.name = "DeliveryDispatchError";
    this.route_id = route_id;
    this.destination_id = destination_id;
  }
}

// Heartbeat throttle — once per minute of batches is enough. Same
// pattern as ingest-worker: module-scoped state survives across
// batches handled by the same isolate.
let lastRouterHeartbeatAt = 0;
let routerHeartbeatTickCount = 0;
const ROUTER_HEARTBEAT_THROTTLE_MS = 60 * 1000;

// Cross-batch route cache. A warm isolate reuses route lookups for the same
// (workspace, source) for ROUTE_CACHE_TTL_MS instead of re-hitting
// delivery-service /internal/routes on every batch — the previous per-batch
// Map started cold each batch (~46% route-lookup timeouts under load). Worker
// env isn't readable at module scope, so the TTL is a fixed 30s. Route config
// changes propagate within the TTL; the cache is single-flight and evicts
// failed loads immediately.
const ROUTE_CACHE_TTL_MS = 30_000;
const routeCache = createTtlCache<RouteWithTypes[]>({ ttlMs: ROUTE_CACHE_TTL_MS });

function maybeBeatRouter(env: Env, ctx: ExecutionContext, error?: string): void {
  let url: string | null = null;
  try {
    url = env.DELIVERY_HEARTBEAT_URL
      ? validateInternalServiceEndpoint(env.DELIVERY_HEARTBEAT_URL, "/internal/heartbeat")
      : env.DELIVERY_SERVICE_URL
        ? resolveInternalServiceEndpoint(env.DELIVERY_SERVICE_URL, "/internal/heartbeat")
        : null;
  } catch {
    return;
  }
  const secret = env.DELIVERY_SHARED_SECRET;
  if (!url || !secret) return;
  const now = Date.now();
  if (now - lastRouterHeartbeatAt < ROUTER_HEARTBEAT_THROTTLE_MS && !error) return;
  lastRouterHeartbeatAt = now;
  routerHeartbeatTickCount += 1;
  ctx.waitUntil(
    recordHeartbeatHttp(url, secret, {
      component: "router-edge",
      tickCount: routerHeartbeatTickCount,
      ...(error ? { error } : {}),
      expectedIntervalSeconds: 180,
      environment: env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? "production",
    }),
  );
}

export default {
  async queue(batch: MessageBatch<QueueMessage>, env: Env, ctx: ExecutionContext): Promise<void> {
    const sentry = sentryClientFromEnv(env, "router-edge");
    maybeBeatRouter(env, ctx);
    for (const msg of batch.messages) {
      try {
        await processOne(msg.body, env);
        msg.ack();
      } catch (err) {
        // Preserve the actual router exception before Cloudflare replaces it
        // with a generic auto-DLQ `max_retries_exceeded` payload.
        console.error(`[router] processing failed: ${routerErrorMessage(err)}`);
        const finalAttempt = msg.attempts >= ROUTER_CONSUMER_MAX_RETRIES;
        const transientR2Read = isTransientR2Error(err);
        // AXE-65 — `env.DELIVERY_QUEUE.send()` throws "Queue is overloaded
        // (10250)" under producer rate-limit pressure. That's transient
        // backpressure, not a code bug — skip Sentry and let CF re-deliver.
        const queueOverload = isCloudflareQueueOverloadError(err);
        const routeLookupUnavailable = isRouteLookupUnavailableError(err);
        const cloudflareInternal = isCloudflareInternalError(err);
        if (!transientR2Read && (((!queueOverload && !routeLookupUnavailable && !cloudflareInternal)) || finalAttempt)) {
          ctx.waitUntil(captureException(sentry, err, {
            tags: {
              component: "queue_process",
              queue: batch.queue,
              event_id: msg.body.event_id,
              source_id: msg.body.source_id,
              final_attempt: finalAttempt,
              ...(transientR2Read ? { category: "r2_transient_read" } : {}),
              ...(queueOverload ? { category: "cloudflare_queue_overload" } : {}),
              ...(routeLookupUnavailable ? { category: "route_lookup_unavailable" } : {}),
              ...(cloudflareInternal ? { category: "cloudflare_internal" } : {}),
            },
          }));
        }
        if (finalAttempt) {
          await deadLetterRouterFailure(msg.body, env, err);
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  },
};

export async function processOne(
  message: QueueMessage,
  env: Env,
): Promise<void> {
  if (!isCanonicalRawPayloadKey(message.r2_key, {
    workspaceId: message.workspace_id,
    eventId: message.event_id,
    sourceId: message.source_id,
  })) {
    throw new Error("raw_payload_key_mismatch");
  }
  const cacheKey = `${message.workspace_id}|${message.source_id}`;
  const routes = await routeCache.getOrLoad(cacheKey, () =>
    loadActiveRoutes(env, message.workspace_id, message.source_id),
  );
  if (routes.length === 0) {
    // No matching routes — the event is "received but unrouted". This is
    // legal (a source with no routes yet), so we don't dead-letter.
    return;
  }

  const enqueuedAt = new Date().toISOString();

  // Pull raw from R2 once per event, not once per route — needed for both
  // declarative engine evaluation and for unmodified pass-through. The same
  // key backs every route, so re-reading it inside the loop only multiplied
  // R2 GETs (and their retries) by the number of active routes.
  const raw = await getRawEventWithRetry(env.EVENTS_RAW, message.r2_key);
  if (!raw) {
    // Keep per-route dead-letter attribution: each active route records its
    // own raw_payload_missing entry, exactly as when the read was per-route.
    for (const route of routes) {
      await env.DEAD_LETTER_QUEUE.send({
        workspace_id: message.workspace_id,
        event_id: message.event_id,
        source_id: message.source_id,
        route_id: route.route_id,
        r2_key: message.r2_key,
        reason: "raw_payload_missing",
        message: "Raw payload lookup returned no object.",
        errored_at: enqueuedAt,
      });
    }
    return;
  }
  const bodyArrayBuffer = await raw.arrayBuffer();
  const decodedPayload = decodePayload(bodyArrayBuffer, message.content_type);

  for (const route of routes) {
    // Shared routing core (packages/shared/route-fanout.ts): the declarative
    // engine (graph or legacy filter/transform) sees the ORIGINAL decoded
    // payload, and the source's field_selection is projected onto each
    // delivery payload AFTER fan-out — identical to the Node router and the
    // dashboard preview. (This worker previously projected BEFORE the engine
    // ran; that drift is deliberately resolved in favor of the preview
    // semantics.) The R2-stored raw payload is untouched either way, so an
    // operator can replay later with a wider selection.
    const fanout = evaluateRouteFanout(route, decodedPayload, {
      message,
      enqueued_at: enqueuedAt,
    });

    if (fanout.outcome === "skipped") continue;
    if (fanout.outcome === "engine_error") {
      // Route-error channel — mirrors the Node router's handleBreach: mark
      // the route errored (via delivery-service, best-effort) AND push a
      // structured dead-letter. Previously the edge only dead-lettered, so a
      // bad graph auto-disabled the route on replay but kept burning live
      // traffic here.
      await reportRouteEngineError(env, message, route.route_id, fanout, enqueuedAt);
      continue;
    }

    for (const delivery of fanout.deliveries) {
      const destinationMessage = delivery.message;
      const destinationId = destinationMessage.destination_id;
      const binding = destinationMessage.binding ?? null;

      // Route to the runtime whose connector can satisfy this destination's
      // type. Default (unknown / missing type lookup) → DELIVERY_QUEUE so we
      // never silently drop a delivery.
      const destinationType = delivery.destination_type ?? undefined;
      const useNative = requiresNativeRuntimeDestination(destinationType, binding);
      const runtime = useNative ? "native" : "edge";
      // Parquet-S3 routes to a dedicated queue (drained by ONE worker instance)
      // when it's provisioned, so batching never fans out across replicas.
      // Until DELIVERY_PARQUET_QUEUE exists it falls back to the native queue —
      // the web role still delivers Parquet exactly as before.
      const isParquet = destinationType === "s3" && isParquetObjectStoreBinding(binding);
      const targetQueue =
        isParquet && env.DELIVERY_PARQUET_QUEUE
          ? env.DELIVERY_PARQUET_QUEUE
          : useNative
            ? env.DELIVERY_NATIVE_QUEUE
            : env.DELIVERY_QUEUE;

      // Both runtime paths go through durable queues. Cloudflare caps a single
      // message at 128KB; transforms that fan out a large payload (or large
      // headers/query) can exceed that, so we spill the heavy fields to R2
      // first and replace them with a `spill_r2_key`. The consumer hydrates
      // from R2 before invoking the connector.
      let queueMessage: DestinationQueueMessage;
      try {
        queueMessage = await spillIfOversized(
          destinationMessage,
          spillWriterFromR2(env.EVENTS_RAW),
        );
      } catch (err) {
        throw new DeliveryDispatchError(
          `${runtime}_queue_spill_failed: ${routerErrorMessage(err)}`,
          route.route_id,
          destinationId,
        );
      }
      console.log(
        `[router] type=${destinationType ?? "(unknown)"} → ${runtime} (queue)${queueMessage.spill_r2_key ? " spilled" : ""}`,
      );
      // Force `contentType: "json"` so messages survive the HTTP-pull API
      // round-trip used by the Render delivery service. The default ("v8")
      // structured-clone format only works between Cloudflare Workers — pull
      // consumers receive it base64-encoded and can't parse it.
      await enqueueDeliveryQueue(targetQueue, queueMessage, runtime, route.route_id, destinationId);
    }
  }
}

async function enqueueDeliveryQueue(
  queue: Queue<DestinationQueueMessage>,
  message: DestinationQueueMessage,
  runtime: "edge" | "native",
  routeId: string,
  destinationId: string,
): Promise<void> {
  try {
    await queue.send(message, { contentType: "json" });
  } catch (err) {
    throw new DeliveryDispatchError(
      `${runtime}_queue_enqueue_failed: ${routerErrorMessage(err)}`,
      routeId,
      destinationId,
    );
  }
}

function spillWriterFromR2(bucket: R2Bucket): QueueSpillWriter {
  return {
    async put(key: string, body: string): Promise<void> {
      await bucket.put(key, body, {
        httpMetadata: { contentType: "application/json" },
      });
    },
  };
}

async function deadLetterRouterFailure(
  message: QueueMessage,
  env: Env,
  err: unknown,
): Promise<void> {
  // A DeliveryDispatchError knows exactly which route + destination the
  // failure was for (it escaped the per-destination loop). Any other error —
  // an unexpected exception around routing — genuinely has no single target,
  // so leave route_id empty and omit destination_id.
  const dispatch = err instanceof DeliveryDispatchError ? err : null;
  await env.DEAD_LETTER_QUEUE.send({
    workspace_id: message.workspace_id,
    event_id: message.event_id,
    source_id: message.source_id,
    route_id: dispatch?.route_id ?? "",
    ...(dispatch?.destination_id ? { destination_id: dispatch.destination_id } : {}),
    r2_key: message.r2_key,
    reason: "router_processing_failed",
    message: routerErrorMessage(err),
    errored_at: new Date().toISOString(),
  });
}

export function routerErrorMessage(err: unknown): string {
  return sanitizeConnectorDiagnosticForStorage(
    err instanceof Error ? err.message : String(err),
    500,
  );
}

/** Exported for focused adapter regression tests. */
export async function getRawEventWithRetry(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= R2_READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await bucket.get(key);
    } catch (err) {
      lastErr = err;
      if (!isTransientR2Error(err) || attempt === R2_READ_RETRY_ATTEMPTS) break;
      await sleep(R2_READ_RETRY_BASE_DELAY_MS * attempt);
    }
  }
  throw lastErr;
}

export function isRouteLookupUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  // The delivery service sits behind Render's proxy and Cloudflare. Standard
  // gateway failures plus Cloudflare's edge-error family mean the proxy or
  // service is temporarily unavailable; the queue consumer retries the
  // message and only reports the error if the final attempt also fails.
  // Keep ordinary 500s visible because those can be application bugs.
  return /^internal_routes_(?:502|503|504|52[0-7]|530):/i.test(message);
}

function isCloudflareInternalError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown internal error \(15000\)/i.test(message);
}

// Local extension of the shared Route type — carries a per-destination type
// map so the queue-routing decision in processOne doesn't need an extra
// Postgres round-trip per destination. Also carries the source's
// `field_selection` so we can project payloads at fan-out without an extra
// query per event.
type RouteWithTypes = Route & {
  destinationTypes?: Record<string, string>;
};

// Route lookup goes through apps/delivery-service /internal/routes rather
// than directly against Postgres. CF Workers can't reach Render Postgres
// (Render's network blocks CF egress IPs even with `0.0.0.0/0` configured),
// so the query runs on the Render side where Postgres is reachable. Same
// shared-secret auth as `/deliver`.
//
// The wire carries the field selection under BOTH `field_selection`
// (canonical @axel/shared Route key) and the legacy camelCase
// `fieldSelection`; we normalize onto snake_case below so this worker never
// needs a lockstep deploy with delivery-service.
interface InternalRoutesResponse {
  routes: Array<RouteWithTypes & { fieldSelection?: string[] | null }>;
}

const INTERNAL_ROUTES_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

async function loadActiveRoutes(
  env: Env,
  workspaceId: string,
  sourceId: string,
): Promise<RouteWithTypes[]> {
  if (!env.DELIVERY_SERVICE_URL || !env.DELIVERY_SHARED_SECRET) {
    throw new Error(
      "DELIVERY_SERVICE_URL or DELIVERY_SHARED_SECRET not configured — required for route lookup",
    );
  }
  const endpoint = resolveInternalServiceEndpoint(
    env.DELIVERY_SERVICE_URL,
    "/internal/routes",
  );
  const res = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "x-axel-shared-secret": env.DELIVERY_SHARED_SECRET,
    },
    body: JSON.stringify({ workspace_id: workspaceId, source_id: sourceId }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`internal_routes_${res.status}`);
  }
  const data = await readBoundedJsonResponse(
    res,
    INTERNAL_ROUTES_RESPONSE_MAX_BYTES,
  ) as Partial<InternalRoutesResponse>;
  if (!Array.isArray(data?.routes)) throw new Error("internal_routes_invalid");
  return data.routes.map(({ fieldSelection, ...route }) => ({
    ...route,
    field_selection: route.field_selection ?? fieldSelection ?? null,
  }));
}

/**
 * Route-error channel for declarative-engine failures — the edge equivalent
 * of apps/router's handleBreach:
 *
 *   1. Mark the route `errored` via delivery-service (the edge can't reach
 *      Render Postgres) so subsequent traffic skips it until an operator
 *      re-enables it. Best-effort: losing the event is worse than leaving the
 *      route hot for one more message, so a failed mark is logged, never
 *      thrown.
 *   2. Evict the route cache entry so this isolate stops evaluating the
 *      errored route within the TTL window.
 *   3. Push the original event onto the dead-letter queue (stable
 *      RouteEngineError reason for triage). This one still throws on failure
 *      — same as before — so the queue redelivers rather than dropping.
 */
async function reportRouteEngineError(
  env: Env,
  message: QueueMessage,
  routeId: string,
  breach: { reason: string; message: string },
  erroredAt: string,
): Promise<void> {
  const storedBreach = {
    reason: breach.reason,
    message: sanitizeConnectorDiagnosticForStorage(breach.message, 400),
  };
  await markRouteErrored(env, message.workspace_id, routeId, storedBreach).catch((err) => {
    console.error(
      `[router] failed to mark route errored: ${sanitizeConnectorDiagnosticForStorage(err)}`,
    );
  });
  routeCache.invalidate(`${message.workspace_id}|${message.source_id}`);
  await env.DEAD_LETTER_QUEUE.send({
    workspace_id: message.workspace_id,
    event_id: message.event_id,
    source_id: message.source_id,
    route_id: routeId,
    r2_key: message.r2_key,
    reason: storedBreach.reason,
    message: storedBreach.message,
    errored_at: erroredAt,
  });
}

/** Exported for focused adapter regression tests. */
export async function markRouteErrored(
  env: Pick<Env, "DELIVERY_SERVICE_URL" | "DELIVERY_SHARED_SECRET">,
  workspaceId: string,
  routeId: string,
  breach: { reason: string; message: string },
): Promise<void> {
  if (!env.DELIVERY_SERVICE_URL || !env.DELIVERY_SHARED_SECRET) {
    throw new Error("DELIVERY_SERVICE_URL or DELIVERY_SHARED_SECRET not configured");
  }
  const endpoint = resolveInternalServiceEndpoint(
    env.DELIVERY_SERVICE_URL,
    "/internal/routes/errored",
  );
  const res = await fetch(endpoint, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "x-axel-shared-secret": env.DELIVERY_SHARED_SECRET,
    },
    body: JSON.stringify({
      workspace_id: workspaceId,
      route_id: routeId,
      reason: breach.reason,
      message: breach.message,
    }),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`internal_routes_errored_${res.status}`);
  }
  await res.body?.cancel().catch(() => undefined);
}

// NOTE: deliberately different from apps/router's decodePayload — this one
// treats any content type containing "json" as JSON and falls back to the raw
// text on a parse failure, while the Node router only matches
// application/json / +json and THROWS on malformed JSON (dead-lettering the
// event). Do not consolidate without deciding that difference explicitly.
function decodePayload(raw: ArrayBuffer, contentType: string): unknown {
  const text = new TextDecoder().decode(raw);
  if (contentType.toLowerCase().includes("json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}
