import { describe, expect, it, vi } from "vitest";
import {
  createInMemoryRouterDeps,
  processQueueMessage,
} from "../src/index.ts";
import type { QueueMessage } from "@axel/shared";
import type { RouteWithDestinationTypes } from "../src/index.ts";

const receivedAt = "2026-05-02T12:00:00.000Z";
const now = () => new Date("2026-05-02T12:00:01.000Z");
const RAW_KEY = "events/ws-1/2026-05-02/evt-1";

describe("router processor (declarative engine)", () => {
  it("rejects a foreign raw key before R2, route, or delivery access", async () => {
    const deps = createInMemoryRouterDeps({
      routes: [route({ route_id: "rt-1", destination_ids: ["dest-a"] })],
    });
    const r2Get = vi.fn(async () => null);
    deps.rawPayloads = { get: r2Get };
    const routeLookup = vi.spyOn(deps.routes, "listActiveBySource");

    await expect(processQueueMessage(deps, message({
      r2_key: "events/ws-victim/2026-05-02/evt-1",
    }))).rejects.toThrow("raw_payload_key_mismatch");

    expect(r2Get).not.toHaveBeenCalled();
    expect(routeLookup).not.toHaveBeenCalled();
    expect(deps.deliveryRecords).toHaveLength(0);
    expect(deps.nativeDeliveryRecords).toHaveLength(0);
  });

  it("evaluates active routes and enqueues one delivery per destination", async () => {
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ total: 21, type: "invoice.paid" }),
      },
      routes: [
        route({
          route_id: "rt-1",
          // Only invoice.paid events flow through this route.
          filter_expression: JSON.stringify({
            kind: "event_type_in",
            path: "type",
            values: ["invoice.paid"],
          }),
          // Reshape: project { amount, source_type } from the body.
          transform_script: JSON.stringify({
            kind: "select",
            assignments: { amount: "total", source_type: "type" },
          }),
          destination_ids: ["dest-a", "dest-b"],
        }),
        route({
          route_id: "rt-skip",
          // Filter to event types that won't match — exercises the
          // skip path.
          filter_expression: JSON.stringify({
            kind: "event_type_in",
            path: "type",
            values: ["invoice.refunded"],
          }),
          destination_ids: ["dest-skip"],
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result).toEqual({
      event_id: "evt-1",
      matched_routes: 1,
      skipped_routes: 1,
      enqueued_deliveries: 2,
      dead_lettered: 0,
    });
    expect(deps.deliveryRecords).toHaveLength(2);
    expect(deps.deliveryRecords.map((r) => r.destination_id)).toEqual(["dest-a", "dest-b"]);
    expect(deps.deliveryRecords[0]?.payload).toEqual({ amount: 21, source_type: "invoice.paid" });
    expect(deps.deliveryRecords[0]?.enqueued_at).toBe("2026-05-02T12:00:01.000Z");
    expect(deps.deliveryRecords[0]?.attempt_no).toBe(1);
    expect(deps.deliveryRecords[0]?.idempotency_key).toBe("ws-1:evt-1:rt-1:dest-a");
  });

  it("accepts the canonical pull-worker raw key shape", async () => {
    const pullKey = "pull/ws-1/src-1/customers/evt-pull.json";
    const deps = createInMemoryRouterDeps({
      payloads: { [pullKey]: "{}" },
      routes: [],
    });

    await expect(processQueueMessage(deps, message({
      event_id: "evt-pull",
      r2_key: pullKey,
    }))).resolves.toMatchObject({ event_id: "evt-pull" });
  });

  it("dead-letters routes whose declarative DSL fails to parse and leaves other routes flowing", async () => {
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ ok: true }),
      },
      routes: [
        route({
          route_id: "rt-bad",
          // Invalid JSON — RouteEngineError.reason will be `filter_invalid_json`.
          filter_expression: "{not valid json",
          destination_ids: ["dest-bad"],
        }),
        route({
          route_id: "rt-good",
          destination_ids: ["dest-good"],
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.dead_lettered).toBe(1);
    expect(result.enqueued_deliveries).toBe(1);
    expect(deps.deadLetter.records).toHaveLength(1);
    expect(deps.deadLetter.records[0]?.route_id).toBe("rt-bad");
    expect(deps.deadLetter.records[0]?.reason).toBe("filter_invalid_json");
    expect(deps.routeStore.records.find((r) => r.route_id === "rt-bad")?.status).toBe("errored");
    expect(deps.deliveryRecords[0]?.destination_id).toBe("dest-good");
  });

  it("sends native-runtime destinations to the native queue when route metadata includes destination types", async () => {
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ ok: true }),
      },
      routes: [
        route({
          route_id: "rt-typed",
          destination_ids: ["dest-http", "dest-mongo", "dest-postgres"],
          destinationTypes: {
            "dest-http": "http",
            "dest-mongo": "mongodb",
            "dest-postgres": "postgres",
          },
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.enqueued_deliveries).toBe(3);
    expect(deps.deliveryRecords.map((r) => r.destination_id)).toEqual(["dest-http"]);
    expect(deps.nativeDeliveryRecords.map((r) => r.destination_id)).toEqual(["dest-mongo", "dest-postgres"]);
  });

  it("sends S3 parquet bindings to the native queue", async () => {
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ ok: true }),
      },
      routes: [
        route({
          route_id: "rt-s3",
          destination_ids: ["dest-json", "dest-parquet"],
          destinationTypes: {
            "dest-json": "s3",
            "dest-parquet": "s3",
          },
          destination_bindings: {
            "dest-json": { key_prefix: "json/" },
            "dest-parquet": { key_prefix: "lake/", format: "parquet" },
          },
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.enqueued_deliveries).toBe(2);
    expect(deps.deliveryRecords.map((r) => r.destination_id)).toEqual(["dest-json"]);
    expect(deps.nativeDeliveryRecords.map((r) => r.destination_id)).toEqual(["dest-parquet"]);
    expect(deps.nativeDeliveryRecords[0]?.binding).toEqual({
      key_prefix: "lake/",
      format: "parquet",
    });
  });

  it("dead-letters routes that pass an unsafe path through the validator", async () => {
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ type: "x" }),
      },
      routes: [
        route({
          route_id: "rt-bad-path",
          // __proto__ is rejected at validate-time with `filter_event_type_in_bad_path`.
          filter_expression: JSON.stringify({
            kind: "event_type_in",
            path: "__proto__",
            values: ["x"],
          }),
          destination_ids: ["dest-x"],
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.dead_lettered).toBe(1);
    expect(deps.deadLetter.records[0]?.reason).toBe("filter_event_type_in_bad_path");
  });

  it("honors replay scope — restricts fan-out to the scoped route / destination", async () => {
    const setup = () =>
      createInMemoryRouterDeps({
        now,
        payloads: { [RAW_KEY]: JSON.stringify({ ok: true }) },
        routes: [
          route({ route_id: "rt-1", destination_ids: ["dest-a", "dest-b"] }),
          route({ route_id: "rt-2", destination_ids: ["dest-c"] }),
        ],
      });

    // No scope → full fan-out (both routes, all destinations).
    const all = setup();
    await processQueueMessage(all, message());
    expect(all.deliveryRecords.map((r) => r.destination_id).sort()).toEqual(["dest-a", "dest-b", "dest-c"]);

    // scope={routeId} → only that route's destinations (was fanning to all).
    const routeScoped = setup();
    await processQueueMessage(routeScoped, message(), { routeId: "rt-1" });
    expect(routeScoped.deliveryRecords.map((r) => r.destination_id).sort()).toEqual(["dest-a", "dest-b"]);

    // scope={routeId, destinationId} → only that destination.
    const destScoped = setup();
    await processQueueMessage(destScoped, message(), { routeId: "rt-1", destinationId: "dest-a" });
    expect(destScoped.deliveryRecords.map((r) => r.destination_id)).toEqual(["dest-a"]);
  });

  it("dead-letters a REPLAY whose R2 payload is missing instead of dropping it", async () => {
    // No payload registered for the message's r2_key → rawPayloads.get returns null.
    const deps = createInMemoryRouterDeps({
      now,
      routes: [route({ route_id: "rt-1", destination_ids: ["dest-a"] })],
    });

    const result = await processQueueMessage(deps, message(), { routeId: "rt-1" });

    expect(result).toEqual({
      event_id: "evt-1",
      matched_routes: 0,
      skipped_routes: 0,
      enqueued_deliveries: 0,
      dead_lettered: 1,
    });
    expect(deps.deadLetter.records).toHaveLength(1);
    expect(deps.deadLetter.records[0]).toMatchObject({
      event_id: "evt-1",
      route_id: "rt-1",
      reason: "payload_missing",
      r2_key: RAW_KEY,
    });
  });

  it("does NOT dead-letter a normal (unscoped) ingest with a missing payload", async () => {
    // No scope = no target route to attribute to; the payload was lost upstream
    // of routing, so this stays a logged no-op (re-driving would re-fail forever).
    const deps = createInMemoryRouterDeps({
      now,
      routes: [route({ route_id: "rt-1", destination_ids: ["dest-a"] })],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.dead_lettered).toBe(0);
    expect(deps.deadLetter.records).toHaveLength(0);
  });

  // ---- Pinned drift decisions (shared routing core extraction) ---- //

  it("PINS ordering (a): the engine sees the ORIGINAL payload; field_selection projects AFTER fan-out", async () => {
    // The filter references `internal.flag`, which is NOT in the field
    // selection. Unified semantic (matches the dashboard preview): the engine
    // evaluates the full payload — so the filter matches — while the delivered
    // payload is projected down to the selection. router-edge previously
    // projected BEFORE the engine, which would have dropped this event.
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ internal: { flag: "on" }, public: "yes" }),
      },
      routes: [
        route({
          route_id: "rt-1",
          filter_expression: JSON.stringify({
            kind: "event_type_in",
            path: "internal.flag",
            values: ["on"],
          }),
          field_selection: ["public"],
          destination_ids: ["dest-a"],
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.matched_routes).toBe(1);
    expect(deps.deliveryRecords).toHaveLength(1);
    expect(deps.deliveryRecords[0]?.payload).toEqual({ public: "yes" });
  });

  it("PINS ordering (a) for pipeline-graph routes: executeGraph runs on the unprojected payload", async () => {
    const graph = JSON.stringify({
      version: 1,
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_t",
          kind: "transform",
          transform: { kind: "select", assignments: { flag: "internal.flag", id: "event_id" } },
        },
        { id: "n_d", kind: "destination", destination_id: "dest-a" },
      ],
      edges: [
        { from: "n_src", to: "n_t" },
        { from: "n_t", to: "n_d" },
      ],
    });
    const deps = createInMemoryRouterDeps({
      now,
      payloads: {
        [RAW_KEY]: JSON.stringify({ event_id: "evt-1", internal: { flag: "on" } }),
      },
      routes: [
        route({
          route_id: "rt-1",
          pipeline_graph: graph,
          // `internal.flag` is outside the selection; the graph transform must
          // still see it, and the projection applies to the transform OUTPUT.
          field_selection: ["id", "flag"],
          destination_ids: ["dest-a"],
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.matched_routes).toBe(1);
    expect(deps.deliveryRecords[0]?.payload).toEqual({ id: "evt-1", flag: "on" });
    expect(deps.deliveryRecords[0]?.idempotency_key).toBe("ws-1:evt-1:rt-1:dest-a:n_d");
  });

  it("PINS error reporting (b): a pipeline-graph engine error marks the route errored AND dead-letters", async () => {
    const deps = createInMemoryRouterDeps({
      now,
      payloads: { [RAW_KEY]: JSON.stringify({ ok: true }) },
      routes: [
        route({
          route_id: "rt-graph-bad",
          pipeline_graph: "{not valid json",
          destination_ids: ["dest-a"],
        }),
      ],
    });

    const result = await processQueueMessage(deps, message());

    expect(result.dead_lettered).toBe(1);
    expect(deps.deadLetter.records[0]?.route_id).toBe("rt-graph-bad");
    expect(deps.routeStore.records[0]?.status).toBe("errored");
  });
});

function message(overrides: Partial<QueueMessage> = {}): QueueMessage {
  return {
    event_id: "evt-1",
    workspace_id: "ws-1",
    source_id: "src-1",
    r2_key: RAW_KEY,
    received_at: receivedAt,
    content_type: "application/json",
    size_bytes: 42,
    shard: 0,
    headers: { "x-source": "stripe" },
    query: {},
    ...overrides,
  };
}

function route(overrides: Partial<RouteWithDestinationTypes>): RouteWithDestinationTypes {
  return {
    route_id: "rt-default",
    workspace_id: "ws-1",
    source_id: "src-1",
    status: "active",
    destination_ids: [],
    ...overrides,
  };
}
