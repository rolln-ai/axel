/**
 * Routing hot path — the pure per-route fan-out evaluation shared by the two
 * router runtimes (apps/router, Node; apps/router-edge, Cloudflare Worker).
 *
 * Both runtimes used to hand-roll the same sequence — parse `pipeline_graph`
 * → `executeGraph` → per-leaf `deliveryIdempotencyKey` → build
 * `DestinationQueueMessage` — and had drifted in two observable ways. This
 * module is now the single implementation; each app keeps only its IO
 * adapters (R2 read, queue send, spill, dead-letter sink).
 *
 * Deliberate semantics, decided once here (see the PR for the full rationale):
 *
 *  1. FIELD-SELECTION ORDERING — the declarative engine (pipeline graph, or
 *     the legacy single filter/transform) always sees the ORIGINAL decoded
 *     payload; the source's `field_selection` is projected onto each outgoing
 *     delivery payload AFTER fan-out. This matches the Node router and the
 *     dashboard's "Test against recent events" preview (route-test-actions
 *     runs `executeGraph(payloadBefore, …)` on the raw payload) — router-edge
 *     previously projected BEFORE the engine ran, so a filter/transform
 *     referencing a non-selected field silently behaved differently live vs
 *     replay vs preview.
 *
 *  2. ENGINE-ERROR REPORTING — an engine failure is returned as a structured
 *     `engine_error` outcome (stable `RouteEngineError` reason, message capped
 *     at 400 chars). Each runtime must report it through its route-error
 *     channel (Node: `handleBreach` → markErrored + dead-letter; edge:
 *     dead-letter queue + `/internal/routes/errored`), so a bad graph
 *     auto-disables the route on BOTH live traffic and replay.
 *
 * No IO here: no R2, no queues, no DB. The queue-runtime split
 * (edge/native/parquet) and oversize spilling stay with the callers.
 */

import {
  RouteEngineError,
  executeGraph,
  parseFilter,
  parsePipelineGraph,
  parseTransform,
  runFilter,
  runTransform,
  type LeafDelivery,
} from "./route-engine.js";
import { projectPayload } from "./field-selection.js";
import {
  DEFAULT_RETRY_POLICY,
  deliveryIdempotencyKey,
  type DestinationQueueMessage,
  type QueueMessage,
  type Route,
} from "./types.js";

/** A route plus the per-destination type map the runtimes load alongside it. */
export type FanoutRoute = Route & {
  /** destination_id → destination type ("http", "postgres", …) for the
   *  edge/native queue split. Missing entries mean "unknown" (callers default
   *  to the edge queue so a delivery is never silently dropped). */
  destinationTypes?: Record<string, string>;
};

/** The slice of the inbound queue message the fan-out needs. */
export type FanoutMessage = Pick<
  QueueMessage,
  | "event_id"
  | "workspace_id"
  | "source_id"
  | "r2_key"
  | "received_at"
  | "content_type"
  | "size_bytes"
  | "headers"
  | "query"
  | "is_test"
>;

export interface RouteFanoutContext {
  message: FanoutMessage;
  /** ISO timestamp stamped onto every delivery (`enqueued_at`). */
  enqueued_at: string;
}

export interface FanoutDelivery {
  message: DestinationQueueMessage;
  /** Destination type for the runtime-queue split; null when unknown. */
  destination_type: string | null;
}

export type RouteFanoutResult =
  /** Filter dropped the event, or the graph produced zero leaf deliveries. */
  | { outcome: "skipped" }
  /** Declarative engine failed — the caller MUST report this through its
   *  route-error channel (markErrored + dead-letter) so operators see it. */
  | { outcome: "engine_error"; reason: string; message: string }
  /** One ready-to-enqueue DestinationQueueMessage per leaf delivery. */
  | { outcome: "matched"; deliveries: FanoutDelivery[] };

/**
 * Evaluate one route against a decoded payload. Pure: same inputs → same
 * outputs, no IO. `body` is the decoded raw payload (each runtime keeps its
 * own decodePayload — they deliberately differ on malformed JSON).
 */
export function evaluateRouteFanout(
  route: FanoutRoute,
  body: unknown,
  ctx: RouteFanoutContext,
): RouteFanoutResult {
  const hasPipelineGraph =
    typeof route.pipeline_graph === "string" && route.pipeline_graph.length > 0;

  // The engine sees the ORIGINAL payload (decision 1 above); `field_selection`
  // is applied per delivery after fan-out.
  let leafDeliveries: LeafDelivery[];
  if (hasPipelineGraph) {
    // DAG route: walk the graph, one delivery per leaf. CHECK constraint
    // `routes_pipeline_graph_excludes_legacy` guarantees the legacy columns
    // are unset on these rows.
    try {
      const attached = new Set(route.destination_ids);
      const graph = parsePipelineGraph(route.pipeline_graph as string, {
        attached_destination_ids: attached,
        allow_duplicate_destination_nodes: true,
      });
      leafDeliveries = executeGraph(body, graph).deliveries;
    } catch (err) {
      return engineError(err);
    }
    if (leafDeliveries.length === 0) return { outcome: "skipped" };
  } else {
    // Legacy route: single filter (drop if false) + single transform, then
    // uniform fan-out — same payload to every destination, no leaf_node_id so
    // the idempotency key stays byte-equivalent to the pre-DAG shape.
    let payload: unknown = body;
    try {
      if (route.filter_expression && route.filter_expression.length > 0) {
        const filter = parseFilter(route.filter_expression);
        if (!runFilter(payload, filter)) return { outcome: "skipped" };
      }
      if (route.transform_script && route.transform_script.length > 0) {
        const transform = parseTransform(route.transform_script);
        payload = runTransform(payload, transform);
      }
    } catch (err) {
      return engineError(err);
    }
    leafDeliveries = route.destination_ids.map((destination_id) => ({
      destination_id,
      leaf_node_id: "",
      payload,
    }));
  }

  const { message } = ctx;
  const deliveries: FanoutDelivery[] = leafDeliveries.map((delivery) => {
    const destinationId = delivery.destination_id;
    // deliveryIdempotencyKey ignores an empty leaf_node_id, so legacy routes
    // keep matching their existing delivery_idempotency rows.
    const idempotencyKey = deliveryIdempotencyKey({
      workspace_id: message.workspace_id,
      event_id: message.event_id,
      route_id: route.route_id,
      destination_id: destinationId,
      ...(delivery.leaf_node_id ? { leaf_node_id: delivery.leaf_node_id } : {}),
    });
    const binding = route.destination_bindings?.[destinationId] ?? null;
    return {
      message: {
        queue_message_version: 1,
        event_id: message.event_id,
        workspace_id: message.workspace_id,
        source_id: message.source_id,
        route_id: route.route_id,
        destination_id: destinationId,
        r2_key: message.r2_key,
        received_at: message.received_at,
        enqueued_at: ctx.enqueued_at,
        attempt_no: 1,
        max_attempts: DEFAULT_RETRY_POLICY.max_attempts,
        idempotency_key: idempotencyKey,
        content_type: message.content_type,
        size_bytes: message.size_bytes,
        // Field selection applied at fan-out (decision 1): destinations only
        // receive the operator-contracted fields, while the engine — and the
        // R2-stored raw payload — saw the full event.
        payload: projectPayload(delivery.payload, route.field_selection ?? null),
        headers: message.headers,
        query: message.query,
        is_test: message.is_test,
        binding,
      },
      destination_type: route.destinationTypes?.[destinationId] ?? null,
    };
  });

  return { outcome: "matched", deliveries };
}

function engineError(err: unknown): RouteFanoutResult {
  const reason =
    err instanceof RouteEngineError ? err.reason : "declarative_engine_error";
  const message =
    err instanceof Error ? err.message.slice(0, 400) : String(err).slice(0, 400);
  return { outcome: "engine_error", reason, message };
}
