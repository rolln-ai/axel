import { describe, expect, it } from "vitest";
import { evaluateRouteFanout, type FanoutRoute } from "../src/route-fanout.ts";
import type { RouteFanoutContext } from "../src/route-fanout.ts";

const ctx: RouteFanoutContext = {
  message: {
    event_id: "evt_1",
    workspace_id: "ws_1",
    source_id: "src_1",
    r2_key: "raw/evt_1",
    received_at: "2026-08-23T11:59:00.000Z",
    content_type: "application/json",
    size_bytes: 123,
    headers: { "x-h": "1" },
    query: { q: "1" },
    is_test: false,
  },
  enqueued_at: "2026-08-23T12:00:00.000Z",
};

function route(overrides: Partial<FanoutRoute> = {}): FanoutRoute {
  return {
    route_id: "rt_1",
    workspace_id: "ws_1",
    source_id: "src_1",
    status: "active",
    engine: "declarative",
    destination_ids: ["dst_1"],
    ...overrides,
  };
}

describe("evaluateRouteFanout — legacy routes", () => {
  it("passthrough route fans out one delivery per destination with legacy idempotency keys", () => {
    const result = evaluateRouteFanout(
      route({ destination_ids: ["dst_1", "dst_2"], destinationTypes: { dst_2: "postgres" } }),
      { a: 1 },
      ctx,
    );
    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.deliveries).toHaveLength(2);
    expect(result.deliveries[0]!.message).toMatchObject({
      event_id: "evt_1",
      route_id: "rt_1",
      destination_id: "dst_1",
      attempt_no: 1,
      enqueued_at: "2026-08-23T12:00:00.000Z",
      // No leaf_node_id suffix — byte-equivalent to the pre-DAG key shape.
      idempotency_key: "ws_1:evt_1:rt_1:dst_1",
      payload: { a: 1 },
      binding: null,
    });
    expect(result.deliveries[0]!.destination_type).toBeNull();
    expect(result.deliveries[1]!.destination_type).toBe("postgres");
  });

  it("filter=false → skipped", () => {
    const result = evaluateRouteFanout(
      route({
        filter_expression: JSON.stringify({
          kind: "event_type_in",
          path: "kind",
          values: ["other"],
        }),
      }),
      { kind: "signup" },
      ctx,
    );
    expect(result).toEqual({ outcome: "skipped" });
  });

  it("engine failure → engine_error with the stable reason", () => {
    const result = evaluateRouteFanout(
      route({ filter_expression: "{not json" }),
      { a: 1 },
      ctx,
    );
    expect(result.outcome).toBe("engine_error");
    if (result.outcome !== "engine_error") return;
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.message.length).toBeLessThanOrEqual(400);
  });

  it("PINS ordering decision (a): the filter sees the ORIGINAL payload, field_selection applies after fan-out", () => {
    // The filter references `internal.flag`, which is NOT in the field
    // selection. Preview/Node semantics: the engine sees the full payload
    // (filter matches), while the delivered payload is projected down.
    const result = evaluateRouteFanout(
      route({
        filter_expression: JSON.stringify({
          kind: "event_type_in",
          path: "internal.flag",
          values: ["on"],
        }),
        field_selection: ["public"],
      }),
      { internal: { flag: "on" }, public: "yes" },
      ctx,
    );
    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.deliveries[0]!.message.payload).toEqual({ public: "yes" });
  });

  it("projects the payload AFTER the transform (transform output is what gets projected)", () => {
    const result = evaluateRouteFanout(
      route({
        transform_script: JSON.stringify({
          kind: "select",
          assignments: { keep: "a", drop: "b" },
        }),
        field_selection: ["keep"],
      }),
      { a: 1, b: 2 },
      ctx,
    );
    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.deliveries[0]!.message.payload).toEqual({ keep: 1 });
  });
});

describe("evaluateRouteFanout — pipeline-graph routes", () => {
  const graph = JSON.stringify({
    version: 1,
    nodes: [
      { id: "n_src", kind: "source" },
      {
        id: "n_t1",
        kind: "transform",
        transform: { kind: "select", assignments: { id: "event_id", flag: "internal.flag" } },
      },
      { id: "n_d1", kind: "destination", destination_id: "dst_1" },
    ],
    edges: [
      { from: "n_src", to: "n_t1" },
      { from: "n_t1", to: "n_d1" },
    ],
  });

  it("PINS ordering decision (a): executeGraph runs on the ORIGINAL payload (matches the dashboard preview)", () => {
    // `internal.flag` is outside the field selection; the graph transform must
    // still see it (router-edge used to project BEFORE the engine, hiding it).
    const result = evaluateRouteFanout(
      route({
        pipeline_graph: graph,
        field_selection: ["id", "flag"],
        destination_bindings: { dst_1: { table: "t", mode: "jsonb_blob" } },
      }),
      { event_id: "evt_42", internal: { flag: true } },
      ctx,
    );
    expect(result.outcome).toBe("matched");
    if (result.outcome !== "matched") return;
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]!.message).toMatchObject({
      destination_id: "dst_1",
      // Graph leaves append the leaf node id to the idempotency key.
      idempotency_key: "ws_1:evt_1:rt_1:dst_1:n_d1",
      // Transform saw the original payload; projection applied to its OUTPUT.
      payload: { id: "evt_42", flag: true },
      binding: { table: "t", mode: "jsonb_blob" },
    });
  });

  it("zero leaf deliveries → skipped", () => {
    const filteringGraph = JSON.stringify({
      version: 1,
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_f",
          kind: "filter",
          filter: { kind: "event_type_in", path: "kind", values: ["other"] },
        },
        { id: "n_d1", kind: "destination", destination_id: "dst_1" },
      ],
      edges: [
        { from: "n_src", to: "n_f" },
        { from: "n_f", to: "n_d1" },
      ],
    });
    const result = evaluateRouteFanout(
      route({ pipeline_graph: filteringGraph }),
      { kind: "signup" },
      ctx,
    );
    expect(result).toEqual({ outcome: "skipped" });
  });

  it("graph referencing an unattached destination → engine_error", () => {
    const result = evaluateRouteFanout(
      route({ pipeline_graph: graph, destination_ids: ["dst_other"] }),
      { event_id: "evt_42" },
      ctx,
    );
    expect(result.outcome).toBe("engine_error");
  });
});
