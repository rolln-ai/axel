/**
 * Router processor — declarative engine only.
 *
 * The legacy JS sandbox was removed in AXE-24: it was never wired up
 * in the production edge router and the dashboard had been quietly
 * dead-lettering every event with `filter_expression`/`transform_script`.
 * The only remaining engine is the eval-free declarative DSL in
 * `@axel/shared/route-engine`, which runs identically here, in
 * apps/router-edge, and in any future Node-runtime router.
 *
 * `legacy_js` rows are tolerated (the column still allows the value)
 * but they will only have a filter/transform on routes that pre-dated
 * migration 0009; those rows were auto-disabled in that migration.
 * Anything we encounter at runtime that isn't declarative-with-DSL is
 * treated as passthrough.
 */
import {
  evaluateRouteFanout,
  type DestinationQueueMessage,
  type QueueMessage,
  type QueueSpillWriter,
  type Route,
  mapWithConcurrency,
  spillIfOversized,
  toArrayBuffer,
  requiresNativeRuntimeDestination,
} from "@axel/shared";
import {
  handleBreach,
  inMemoryDeadLetterSink,
  inMemoryRouteStatusStore,
  type DeadLetterRecord,
  type DeadLetterSink,
  type RouteStatusStore,
} from "./breach.ts";

export interface RawPayloadStore {
  get(key: string): Promise<ArrayBuffer | null>;
}

export type RouteWithDestinationTypes = Route & {
  destinationTypes?: Record<string, string>;
};

export interface RouteStore {
  listActiveBySource(workspaceId: string, sourceId: string): Promise<RouteWithDestinationTypes[]>;
  markErrored(routeId: string, reason: string, message: string): Promise<void>;
}

export interface DeliveryQueueSink {
  enqueue(message: DestinationQueueMessage): Promise<void>;
}

export interface EventLogSink {
  record(event: string, payload: unknown): Promise<void> | void;
}

export interface RouterDeps {
  rawPayloads: RawPayloadStore;
  routes: RouteStore;
  destinationQueue: DeliveryQueueSink;
  nativeDestinationQueue?: DeliveryQueueSink;
  deadLetter: DeadLetterSink;
  /**
   * Optional R2 writer for spilling oversized queue messages.
   * Without it, the processor will enqueue messages of any size and
   * rely on the sink to reject (Cloudflare 413 above 128KB).
   * Required in production; in-memory tests can omit it.
   */
  spillStore?: QueueSpillWriter;
  logger?: EventLogSink;
  now?: () => Date;
  maxConcurrentMessages?: number;
}

export interface RouterProcessResult {
  event_id: string;
  matched_routes: number;
  skipped_routes: number;
  enqueued_deliveries: number;
  dead_lettered: number;
}

export async function processQueueBatch(
  deps: RouterDeps,
  messages: QueueMessage[],
): Promise<RouterProcessResult[]> {
  return mapWithConcurrency(
    messages,
    deps.maxConcurrentMessages ?? 32,
    (message) => processQueueMessage(deps, message),
  );
}

async function enqueueWithSpill(
  deps: RouterDeps,
  message: DestinationQueueMessage,
  destinationType: string | null | undefined,
): Promise<void> {
  const final = deps.spillStore
    ? await spillIfOversized(message, deps.spillStore)
    : message;
  const target = deps.nativeDestinationQueue && requiresNativeRuntimeDestination(destinationType, message.binding)
    ? deps.nativeDestinationQueue
    : deps.destinationQueue;
  await target.enqueue(final);
}

/**
 * Optional fan-out restriction for replays. A scope='route' replay must
 * re-deliver ONLY to its route, and scope='destination' ONLY to that route's
 * destination — otherwise a single-route replay fans out to every active route
 * on the source (audit: replay scope never enforced). Omitted = full fan-out
 * (normal ingest path, unchanged).
 */
export interface FanoutScope {
  routeId?: string | null;
  destinationId?: string | null;
}

export async function processQueueMessage(
  deps: RouterDeps,
  message: QueueMessage,
  scope?: FanoutScope,
): Promise<RouterProcessResult> {
  const raw = await deps.rawPayloads.get(message.r2_key);
  if (!raw) {
    await deps.logger?.record("router.payload_missing", {
      event_id: message.event_id,
      r2_key: message.r2_key,
    });
    // A REPLAY whose R2 payload is gone must NOT vanish silently — record a
    // dead_letter so it stays visible in the inbox (audit: data loss). The
    // normal ingest path (no scope) is left as a logged no-op: there's no route
    // to attribute the failure to, the payload was lost upstream of routing, and
    // re-driving the same key would re-fail forever. The replay carries a target
    // route (scope.routeId), so we attribute the dead_letter to it. A bare
    // route_id is required by the dead_letters schema, so only dead-letter when
    // we have one.
    const replayRouteId = scope && "routeId" in scope ? scope.routeId ?? null : null;
    let deadLettered = 0;
    if (replayRouteId) {
      const now = (deps.now ?? (() => new Date()))().toISOString();
      await deps.deadLetter.push({
        workspace_id: message.workspace_id,
        event_id: message.event_id,
        source_id: message.source_id,
        route_id: replayRouteId,
        r2_key: message.r2_key,
        reason: "payload_missing",
        message: `Replay payload not found in storage (r2_key=${message.r2_key}).`,
        errored_at: now,
      });
      deadLettered = 1;
    }
    return {
      event_id: message.event_id,
      matched_routes: 0,
      skipped_routes: 0,
      enqueued_deliveries: 0,
      dead_lettered: deadLettered,
    };
  }

  const body = decodePayload(raw, message.content_type);
  const routes = await deps.routes.listActiveBySource(message.workspace_id, message.source_id);
  const result: RouterProcessResult = {
    event_id: message.event_id,
    matched_routes: 0,
    skipped_routes: 0,
    enqueued_deliveries: 0,
    dead_lettered: 0,
  };

  for (const route of routes) {
    // Replay scope: skip routes other than the one being replayed. Gate on the
    // KEY being present (route + destination scopes both set routeId), NOT its
    // truthiness — a route/destination replay with a null route_id must match
    // nothing (real routes have non-null ids), never fan out to every route.
    if (scope && "routeId" in scope && route.route_id !== scope.routeId) {
      continue;
    }

    // Shared routing core (packages/shared/route-fanout.ts): the engine sees
    // the ORIGINAL payload; field_selection is projected per delivery after
    // fan-out. Identical to router-edge and to the dashboard preview.
    const enqueuedAt = (deps.now ?? (() => new Date()))().toISOString();
    const fanout = evaluateRouteFanout(route, body, {
      message,
      enqueued_at: enqueuedAt,
    });

    if (fanout.outcome === "engine_error") {
      // Route-error channel: mark the route errored + push a structured
      // dead-letter with the stable RouteEngineError reason, so operators can
      // tell exactly which part of the codegen output is wrong.
      await handleBreach(
        {
          routes: deps.routes,
          deadLetter: deps.deadLetter,
          ...(deps.now ? { now: deps.now } : {}),
        },
        {
          workspace_id: message.workspace_id,
          event_id: message.event_id,
          source_id: message.source_id,
          route_id: route.route_id,
          r2_key: message.r2_key,
        },
        { reason: fanout.reason, message: fanout.message },
      );
      result.dead_lettered += 1;
      continue;
    }

    if (fanout.outcome === "skipped") {
      result.skipped_routes += 1;
      continue;
    }

    result.matched_routes += 1;
    for (const delivery of fanout.deliveries) {
      // Replay scope='destination': only the targeted destination. Gate on the
      // KEY (a destination scope sets destinationId; route/all scopes don't),
      // so a null destinationId matches nothing instead of fanning to all.
      if (
        scope
        && "destinationId" in scope
        && delivery.message.destination_id !== scope.destinationId
      ) {
        continue;
      }
      await enqueueWithSpill(deps, delivery.message, delivery.destination_type);
      result.enqueued_deliveries += 1;
    }
  }

  await deps.logger?.record("router.processed", result);
  return result;
}

export function createInMemoryRouterDeps(init?: {
  payloads?: Record<string, ArrayBuffer | string>;
  routes?: RouteWithDestinationTypes[];
  now?: () => Date;
}): RouterDeps & {
  deliveryRecords: DestinationQueueMessage[];
  nativeDeliveryRecords: DestinationQueueMessage[];
  routeStore: RouteStore & RouteStatusStore & { records: RouteWithDestinationTypes[] };
  deadLetter: ReturnType<typeof inMemoryDeadLetterSink>;
} {
  const payloads = new Map<string, ArrayBuffer>();
  for (const [key, value] of Object.entries(init?.payloads ?? {})) {
    payloads.set(key, typeof value === "string" ? toArrayBuffer(new TextEncoder().encode(value)) : value);
  }
  const routeStatus = inMemoryRouteStatusStore();
  const routeStore: RouteStore & RouteStatusStore & { records: RouteWithDestinationTypes[] } = {
    records: [...(init?.routes ?? [])],
    async listActiveBySource(workspaceId, sourceId) {
      return this.records.filter(
        (route) =>
          route.workspace_id === workspaceId
          && route.source_id === sourceId
          && route.status === "active"
          && !routeStatus.errored.has(route.route_id),
      );
    },
    async markErrored(routeId, reason, message) {
      await routeStatus.markErrored(routeId, reason, message);
      this.records = this.records.map((route) =>
        route.route_id === routeId ? { ...route, status: "errored" } : route,
      );
    },
  };
  const deliveryRecords: DestinationQueueMessage[] = [];
  const nativeDeliveryRecords: DestinationQueueMessage[] = [];
  const deadLetter = inMemoryDeadLetterSink();

  return {
    rawPayloads: {
      async get(key) {
        return payloads.get(key) ?? null;
      },
    },
    routes: routeStore,
    destinationQueue: {
      async enqueue(message) {
        deliveryRecords.push(message);
      },
    },
    nativeDestinationQueue: {
      async enqueue(message) {
        nativeDeliveryRecords.push(message);
      },
    },
    deadLetter,
    routeStore,
    deliveryRecords,
    nativeDeliveryRecords,
    ...(init?.now ? { now: init.now } : {}),
  };
}

// NOTE: deliberately different from router-edge's decodePayload — this one
// only matches application/json / +json content types and THROWS on malformed
// JSON (surfacing a dead-letter), while router-edge treats any content type
// containing "json" as JSON and falls back to the raw text on a parse
// failure. Do not consolidate without deciding that difference explicitly.
function decodePayload(raw: ArrayBuffer, contentType: string): unknown {
  const text = new TextDecoder().decode(raw);
  if (looksLikeJson(contentType)) {
    return JSON.parse(text) as unknown;
  }
  return text;
}

function looksLikeJson(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes("application/json") || lower.endsWith("+json");
}

// Re-export for backwards compatibility with tests / e2e suites that
// imported the old DeadLetterRecord type from the processor module.
export type { DeadLetterRecord };
