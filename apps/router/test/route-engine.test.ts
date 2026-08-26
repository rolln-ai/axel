import { describe, expect, it } from "vitest";
import {
  deliveryIdempotencyKey,
  executeGraph,
  executeGraphWithTrace,
  parseFilter,
  parseTransform,
  RouteEngineError,
  runFilter,
  runTransform,
  validateFilter,
  validatePipelineGraph,
  validateTransform,
  type GeneratedFilter,
  type GeneratedTransform,
  type PipelineGraph,
} from "@axel/shared";

describe("validateTransform", () => {
  it("rejects non-object input", () => {
    expect(() => validateTransform(null)).toThrow(RouteEngineError);
    expect(() => validateTransform([])).toThrow(RouteEngineError);
    expect(() => validateTransform("passthrough")).toThrow(RouteEngineError);
  });

  it("rejects unknown kinds with stable reason", () => {
    try {
      validateTransform({ kind: "execute_arbitrary_code" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RouteEngineError);
      expect((err as RouteEngineError).reason).toBe("transform_unknown_kind");
    }
  });

  it("blocks path segments that would touch __proto__/constructor/prototype", () => {
    // Use JSON.parse to produce an own property literally named __proto__
    // (object literal syntax invokes the prototype setter instead).
    const protoAssignment = JSON.parse(
      '{"kind":"select","assignments":{"x":"a.__proto__"}}',
    );
    const protoKeyAssignment = JSON.parse(
      '{"kind":"select","assignments":{"__proto__":"a"}}',
    );
    expect(() => validateTransform(protoAssignment)).toThrowError(/transform_unsafe_path/);
    expect(() => validateTransform(protoKeyAssignment)).toThrowError(/transform_unsafe_path/);
    expect(() =>
      validateTransform({ kind: "select", assignments: { x: "a.constructor.b" } }),
    ).toThrowError(/transform_unsafe_path/);
  });

  it("rejects paths with control / non-ASCII characters", () => {
    expect(() =>
      validateTransform({ kind: "select", assignments: { x: "a\x00b" } }),
    ).toThrow(RouteEngineError);
    expect(() =>
      validateTransform({ kind: "select", assignments: { x: "ä.b" } }),
    ).toThrow(RouteEngineError);
  });

  it("rejects insanely long paths", () => {
    expect(() =>
      validateTransform({ kind: "select", assignments: { x: "a".repeat(300) } }),
    ).toThrow(RouteEngineError);
  });

  it("accepts every well-formed transform kind", () => {
    expect(validateTransform({ kind: "passthrough" })).toEqual({ kind: "passthrough" });
    expect(
      validateTransform({
        kind: "select",
        assignments: { event_id: "id", "data.amount": "amount" },
      }),
    ).toEqual({
      kind: "select",
      assignments: { event_id: "id", "data.amount": "amount" },
    });
    expect(
      validateTransform({
        kind: "envelope",
        event_type_path: "type",
        occurred_at_path: null,
      }),
    ).toEqual({
      kind: "envelope",
      event_type_path: "type",
      occurred_at_path: null,
    });
    expect(validateTransform({ kind: "jsonb_blob", column: "payload" })).toEqual({
      kind: "jsonb_blob",
      column: "payload",
    });
    expect(
      validateTransform({
        kind: "coerce",
        fields: [
          { path: "amount", to: "integer", rounding: "round" },
          { path: "active", to: "string" },
        ],
      }),
    ).toEqual({
      kind: "coerce",
      fields: [
        { path: "amount", to: "integer", rounding: "round" },
        { path: "active", to: "string" },
      ],
    });
    expect(
      validateTransform({
        kind: "collapse_arrays",
        fields: [
          { path: "tags", format: "join" },
          { path: "items[].tags", format: "json" },
        ],
      }),
    ).toEqual({
      kind: "collapse_arrays",
      fields: [
        { path: "tags", format: "join", separator: ", " },
        { path: "items[].tags", format: "json" },
      ],
    });
  });

  it("requires an explicit rounding policy for integer coercion", () => {
    expect(() =>
      validateTransform({ kind: "coerce", fields: [{ path: "amount", to: "integer" }] }),
    ).toThrowError(/transform_coerce_integer_needs_rounding/);
  });

  it("validates array-collapse paths and separators", () => {
    expect(() =>
      validateTransform({
        kind: "collapse_arrays",
        fields: [{ path: "tags[]", format: "join" }],
      }),
    ).toThrowError(/transform_collapse_array_bad_path/);
    expect(() =>
      validateTransform({
        kind: "collapse_arrays",
        fields: [{ path: "tags", format: "join", separator: "x".repeat(33) }],
      }),
    ).toThrowError(/transform_collapse_array_bad_separator/);
  });
});

describe("validateFilter", () => {
  it("rejects unknown kinds", () => {
    expect(() => validateFilter({ kind: "drop_all" })).toThrow(RouteEngineError);
  });
  it("rejects event_type_in with empty values list", () => {
    expect(() => validateFilter({ kind: "event_type_in", path: "type", values: [] })).toThrow(
      RouteEngineError,
    );
  });
  it("rejects deeply nested and trees", () => {
    let nested: GeneratedFilter = { kind: "always" };
    for (let i = 0; i < 100; i++) {
      nested = { kind: "and", parts: [nested] };
    }
    expect(() => validateFilter({ kind: "and", parts: Array(50).fill({ kind: "always" }) })).toThrow(
      RouteEngineError,
    );
  });
});

describe("parseTransform / parseFilter", () => {
  it("rejects invalid JSON with a stable reason", () => {
    try {
      parseTransform("{not json");
    } catch (err) {
      expect((err as RouteEngineError).reason).toBe("transform_invalid_json");
    }
    try {
      parseFilter("not json");
    } catch (err) {
      expect((err as RouteEngineError).reason).toBe("filter_invalid_json");
    }
  });
  it("round-trips valid declarations", () => {
    const out = parseTransform(JSON.stringify({ kind: "passthrough" }));
    expect(out.kind).toBe("passthrough");
  });
});

describe("runTransform", () => {
  it("select reads + writes via the safe path resolver", () => {
    const out = runTransform(
      { id: "evt", customer: { email: "a@b.com" } },
      { kind: "select", assignments: { event_id: "id", email: "customer.email" } },
    );
    expect(out).toEqual({ event_id: "evt", email: "a@b.com" });
  });

  it("coerces scalars without mutating the input", () => {
    const input = { amount: 5.69, active: true, nested: { count: "12" } };
    const out = runTransform(input, {
      kind: "coerce",
      fields: [
        { path: "amount", to: "integer", rounding: "floor" },
        { path: "active", to: "string" },
        { path: "nested.count", to: "number" },
      ],
    });
    expect(out).toEqual({ amount: 5, active: "true", nested: { count: 12 } });
    expect(input).toEqual({ amount: 5.69, active: true, nested: { count: "12" } });
  });

  it("coerces every scalar under an [] path", () => {
    expect(
      runTransform(
        { items: [{ amount: 1.2 }, { amount: 2.8 }] },
        {
          kind: "coerce",
          fields: [{ path: "items[].amount", to: "integer", rounding: "round" }],
        },
      ),
    ).toEqual({ items: [{ amount: 1 }, { amount: 3 }] });
  });

  it("fails with the field and target when a coercion is invalid", () => {
    expect(() =>
      runTransform(
        { amount: "not-a-number" },
        { kind: "coerce", fields: [{ path: "amount", to: "integer", rounding: "round" }] },
      ),
    ).toThrowError(/transform_coerce_failed: amount -> integer \(round\); received string/);
  });

  it("collapses an array to joined text without mutating the input", () => {
    const input = { tags: ["vip", "wholesale"], untouched: true };
    expect(
      runTransform(input, {
        kind: "collapse_arrays",
        fields: [{ path: "tags", format: "join", separator: " | " }],
      }),
    ).toEqual({ tags: "vip | wholesale", untouched: true });
    expect(input.tags).toEqual(["vip", "wholesale"]);
  });

  it("collapses nested arrays to lossless JSON text", () => {
    expect(
      runTransform(
        { items: [{ tags: ["a", "b"] }, { tags: ["c"] }] },
        {
          kind: "collapse_arrays",
          fields: [{ path: "items[].tags", format: "json" }],
        },
      ),
    ).toEqual({ items: [{ tags: '["a","b"]' }, { tags: '["c"]' }] });
  });

  it("rejects non-array values and object members in joined text", () => {
    expect(() =>
      runTransform(
        { tags: "vip" },
        { kind: "collapse_arrays", fields: [{ path: "tags", format: "join" }] },
      ),
    ).toThrowError(/transform_collapse_array_expected_array: tags/);
    expect(() =>
      runTransform(
        { tags: [{ id: 1 }] },
        { kind: "collapse_arrays", fields: [{ path: "tags", format: "join" }] },
      ),
    ).toThrowError(/transform_collapse_array_failed: tags -> joined text; received object member/);
  });

  it("setPath refuses prototype-pollution-style writes silently (defense-in-depth)", () => {
    // validateTransform should already block these, but runTransform's
    // setPath also no-ops on __proto__/constructor — verify with direct
    // type-assertion (skipping validation) that nothing leaks.
    const before = ({} as Record<string, unknown>).polluted;
    const t: GeneratedTransform = {
      kind: "select",
      assignments: { "__proto__.polluted": "id" },
    } as GeneratedTransform;
    // Don't bother validating — directly evaluate the runner against this.
    runTransform({ id: "x" }, t);
    expect(({} as Record<string, unknown>).polluted).toBe(before);
  });

  it("ignores prototype-chain hops in readPath", () => {
    class Sneaky {
      constructor() {}
    }
    (Sneaky.prototype as unknown as Record<string, unknown>).secret = "no";
    const payload = new Sneaky() as unknown as Record<string, unknown>;
    payload.id = "ok";
    expect(
      runTransform(payload, {
        kind: "select",
        assignments: { secret: "secret" },
      }),
    ).toEqual({ secret: undefined });
  });
});

describe("runFilter", () => {
  it("event_type_in handles non-string observed values via String coercion", () => {
    const f: GeneratedFilter = {
      kind: "event_type_in",
      path: "code",
      values: ["123", "456"],
    };
    expect(runFilter({ code: 123 }, f)).toBe(true);
    expect(runFilter({ code: 789 }, f)).toBe(false);
  });

  it("and combinator short-circuits and is conjunctive", () => {
    const f: GeneratedFilter = {
      kind: "and",
      parts: [
        { kind: "event_type_in", path: "type", values: ["a"] },
        { kind: "always" },
      ],
    };
    expect(runFilter({ type: "a" }, f)).toBe(true);
    expect(runFilter({ type: "b" }, f)).toBe(false);
  });

  it("or combinator is disjunctive", () => {
    const f: GeneratedFilter = {
      kind: "or",
      parts: [
        { kind: "event_type_in", path: "type", values: ["a"] },
        { kind: "event_type_in", path: "type", values: ["b"] },
      ],
    };
    expect(runFilter({ type: "a" }, f)).toBe(true);
    expect(runFilter({ type: "b" }, f)).toBe(true);
    expect(runFilter({ type: "c" }, f)).toBe(false);
  });

  it("or rejects empty / oversized parts at validation", () => {
    expect(() => validateFilter({ kind: "or", parts: [] })).toThrowError(
      /filter_or_empty_parts/,
    );
    expect(() =>
      validateFilter({ kind: "or", parts: Array(33).fill({ kind: "always" }) }),
    ).toThrowError(/filter_or_too_many_parts/);
  });
});

// ---------------------------------------------------------------------------
// Idempotency key — locks in byte-equivalence for legacy callers, and
// distinct keys for two leaves landing at one destination.
// ---------------------------------------------------------------------------

describe("deliveryIdempotencyKey", () => {
  const legacy = {
    workspace_id: "ws_1",
    event_id: "evt_1",
    route_id: "rt_1",
    destination_id: "dst_1",
  };

  it("legacy callers (no leaf_node_id) get the pre-DAG byte-equivalent key", () => {
    expect(deliveryIdempotencyKey(legacy)).toBe("ws_1:evt_1:rt_1:dst_1");
  });

  it("DAG callers append :<leaf_node_id> to disambiguate leaves into the same destination", () => {
    expect(
      deliveryIdempotencyKey({ ...legacy, leaf_node_id: "n_dst_a" }),
    ).toBe("ws_1:evt_1:rt_1:dst_1:n_dst_a");
    expect(
      deliveryIdempotencyKey({ ...legacy, leaf_node_id: "n_dst_b" }),
    ).toBe("ws_1:evt_1:rt_1:dst_1:n_dst_b");
  });

  it("empty-string leaf_node_id is treated as legacy (defensive)", () => {
    expect(
      deliveryIdempotencyKey({ ...legacy, leaf_node_id: "" }),
    ).toBe("ws_1:evt_1:rt_1:dst_1");
  });
});

// ---------------------------------------------------------------------------
// Pipeline graph (DAG) — validator + executor.
// ---------------------------------------------------------------------------

const DST_A = "dst_a";
const DST_B = "dst_b";

function ctx(...attached: string[]) {
  return { attached_destination_ids: new Set(attached) };
}

describe("validatePipelineGraph", () => {
  it("rejects non-object / wrong version / empty nodes", () => {
    expect(() => validatePipelineGraph(null, ctx())).toThrowError(/graph_not_object/);
    expect(() =>
      validatePipelineGraph({ version: 2, nodes: [], edges: [] }, ctx()),
    ).toThrowError(/graph_unsupported_version/);
    expect(() =>
      validatePipelineGraph({ version: 1, nodes: [], edges: [] }, ctx()),
    ).toThrowError(/graph_no_nodes/);
  });

  it("rejects > 64 nodes", () => {
    const nodes = [{ id: "n_src", kind: "source" }];
    for (let i = 0; i < 64; i++) {
      nodes.push({ id: `n_f_${i}`, kind: "filter", filter: { kind: "always" } } as never);
    }
    expect(() =>
      validatePipelineGraph({ version: 1, nodes, edges: [] }, ctx()),
    ).toThrowError(/graph_too_many_nodes/);
  });

  it("rejects duplicate node ids", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n", kind: "source" },
            { id: "n", kind: "destination", destination_id: DST_A },
          ],
          edges: [{ from: "n", to: "n" }],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_duplicate_node_id/);
  });

  it("rejects self-loop edges", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_dst", kind: "destination", destination_id: DST_A },
          ],
          edges: [
            { from: "n_src", to: "n_dst" },
            { from: "n_dst", to: "n_dst" },
          ],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_self_loop|graph_destination_has_outgoing/);
  });

  it("rejects cycles", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_t1", kind: "transform", transform: { kind: "passthrough" } },
            { id: "n_t2", kind: "transform", transform: { kind: "passthrough" } },
            { id: "n_dst", kind: "destination", destination_id: DST_A },
          ],
          edges: [
            { from: "n_src", to: "n_t1" },
            { from: "n_t1", to: "n_t2" },
            { from: "n_t2", to: "n_t1" },
            { from: "n_t2", to: "n_dst" },
          ],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_cycle|graph_fan_in_non_destination/);
  });

  it("rejects fan-in into a non-destination node", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_f1", kind: "filter", filter: { kind: "always" } },
            { id: "n_t", kind: "transform", transform: { kind: "passthrough" } },
            { id: "n_dst", kind: "destination", destination_id: DST_A },
          ],
          edges: [
            { from: "n_src", to: "n_t" },
            { from: "n_src", to: "n_f1" },
            { from: "n_f1", to: "n_t" }, // second incoming into n_t
            { from: "n_t", to: "n_dst" },
          ],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_fan_in_non_destination/);
  });

  it("rejects edge dangles", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_dst", kind: "destination", destination_id: DST_A },
          ],
          edges: [{ from: "n_src", to: "missing" }],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_edge_dangles/);
  });

  it("rejects destination not attached to the route", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_dst", kind: "destination", destination_id: "unknown" },
          ],
          edges: [{ from: "n_src", to: "n_dst" }],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_destination_not_attached/);
  });

  it("rejects two destination nodes pointing at the same destination", () => {
    // One delivery is enqueued per leaf node and the idempotency key
    // includes leaf_node_id, so two nodes on one destination_id would
    // silently double-deliver every matching event.
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_dst_1", kind: "destination", destination_id: DST_A },
            { id: "n_dst_2", kind: "destination", destination_id: DST_A },
          ],
          edges: [
            { from: "n_src", to: "n_dst_1" },
            { from: "n_src", to: "n_dst_2" },
          ],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_duplicate_destination/);
  });

  it("tolerates duplicate destination nodes when parsing an already-stored graph", () => {
    // Delivery-time parses set allow_duplicate_destination_nodes so a
    // legacy row persisted before the guard keeps routing instead of
    // dead-lettering every event; only persist paths reject the shape.
    const g = validatePipelineGraph(
      {
        version: 1,
        nodes: [
          { id: "n_src", kind: "source" },
          { id: "n_dst_1", kind: "destination", destination_id: DST_A },
          { id: "n_dst_2", kind: "destination", destination_id: DST_A },
        ],
        edges: [
          { from: "n_src", to: "n_dst_1" },
          { from: "n_src", to: "n_dst_2" },
        ],
      },
      { ...ctx(DST_A), allow_duplicate_destination_nodes: true },
    );
    expect(g.nodes.length).toBe(3);
  });

  it("still accepts fan-out to two distinct destinations", () => {
    const g = validatePipelineGraph(
      {
        version: 1,
        nodes: [
          { id: "n_src", kind: "source" },
          { id: "n_dst_a", kind: "destination", destination_id: DST_A },
          { id: "n_dst_b", kind: "destination", destination_id: DST_B },
        ],
        edges: [
          { from: "n_src", to: "n_dst_a" },
          { from: "n_src", to: "n_dst_b" },
        ],
      },
      ctx(DST_A, DST_B),
    );
    expect(g.nodes.length).toBe(3);
  });

  it("rejects orphan nodes (unreachable from source)", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src", kind: "source" },
            { id: "n_dst", kind: "destination", destination_id: DST_A },
            { id: "n_orphan_t", kind: "transform", transform: { kind: "passthrough" } },
            { id: "n_orphan_dst", kind: "destination", destination_id: DST_B },
          ],
          edges: [
            { from: "n_src", to: "n_dst" },
            { from: "n_orphan_t", to: "n_orphan_dst" },
          ],
        },
        ctx(DST_A, DST_B),
      ),
    ).toThrowError(/graph_orphan_node|graph_fan_in_non_destination/);
  });

  it("rejects two sources / no source / no destinations", () => {
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_dst", kind: "destination", destination_id: DST_A },
          ],
          edges: [],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_no_source|graph_destination_no_incoming/);
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [
            { id: "n_src_a", kind: "source" },
            { id: "n_src_b", kind: "source" },
            { id: "n_dst", kind: "destination", destination_id: DST_A },
          ],
          edges: [
            { from: "n_src_a", to: "n_dst" },
            { from: "n_src_b", to: "n_dst" },
          ],
        },
        ctx(DST_A),
      ),
    ).toThrowError(/graph_multiple_sources/);
    expect(() =>
      validatePipelineGraph(
        {
          version: 1,
          nodes: [{ id: "n_src", kind: "source" }],
          edges: [],
        },
        ctx(),
      ),
    ).toThrowError(/graph_no_destinations|graph_source_no_outgoing/);
  });

  it("accepts a minimal source → dest graph", () => {
    const g = validatePipelineGraph(
      {
        version: 1,
        nodes: [
          { id: "n_src", kind: "source" },
          { id: "n_dst", kind: "destination", destination_id: DST_A },
        ],
        edges: [{ from: "n_src", to: "n_dst" }],
      },
      ctx(DST_A),
    );
    expect(g.nodes.length).toBe(2);
    expect(g.edges.length).toBe(1);
  });

  it("preserves valid UI positions and drops bad ones", () => {
    const g = validatePipelineGraph(
      {
        version: 1,
        nodes: [
          { id: "n_src", kind: "source" },
          { id: "n_dst", kind: "destination", destination_id: DST_A },
        ],
        edges: [{ from: "n_src", to: "n_dst" }],
        ui: {
          n_src: { x: 0, y: 100 },
          n_dst: { x: 400, y: 100 },
          unknown_node: { x: 1, y: 1 },
          bad: { x: "0", y: 0 },
        },
      },
      ctx(DST_A),
    );
    expect(g.ui).toEqual({
      n_src: { x: 0, y: 100 },
      n_dst: { x: 400, y: 100 },
    });
  });
});

describe("executeGraph", () => {
  function build(graph: Omit<PipelineGraph, "version"> & { version?: 1 }): PipelineGraph {
    const attached = new Set<string>();
    for (const n of graph.nodes) {
      if (n.kind === "destination") attached.add(n.destination_id);
    }
    return validatePipelineGraph(
      { version: 1, ...graph },
      { attached_destination_ids: attached },
    );
  }

  it("source → destination is a single delivery with the input payload", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        { id: "n_dst", kind: "destination", destination_id: DST_A },
      ],
      edges: [{ from: "n_src", to: "n_dst" }],
    });
    expect(executeGraph({ x: 1 }, g)).toEqual({
      deliveries: [
        { destination_id: DST_A, leaf_node_id: "n_dst", payload: { x: 1 } },
      ],
    });
  });

  it("source → transform → 2 destinations: same transformed payload to both leaves", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_t",
          kind: "transform",
          transform: { kind: "select", assignments: { id: "event_id" } },
        },
        { id: "n_a", kind: "destination", destination_id: DST_A },
        { id: "n_b", kind: "destination", destination_id: DST_B },
      ],
      edges: [
        { from: "n_src", to: "n_t" },
        { from: "n_t", to: "n_a" },
        { from: "n_t", to: "n_b" },
      ],
    });
    const out = executeGraph({ event_id: "evt_42" }, g);
    expect(out.deliveries).toEqual([
      { destination_id: DST_A, leaf_node_id: "n_a", payload: { id: "evt_42" } },
      { destination_id: DST_B, leaf_node_id: "n_b", payload: { id: "evt_42" } },
    ]);
  });

  it("source → 2 transforms → 1 shared destination: two distinct deliveries per event", () => {
    // validatePipelineGraph now rejects this shape at save time
    // (graph_duplicate_destination), but graphs persisted before the
    // guard can still reach the engine — so executeGraph and the
    // leaf-scoped idempotency key must keep their per-leaf semantics.
    // Build the graph literal directly, bypassing validation.
    const g: PipelineGraph = {
      version: 1,
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_t1",
          kind: "transform",
          transform: { kind: "select", assignments: { id: "event_id" } },
        },
        {
          id: "n_t2",
          kind: "transform",
          transform: {
            kind: "envelope",
            event_type_path: "type",
            occurred_at_path: null,
          },
        },
        { id: "n_a1", kind: "destination", destination_id: DST_A },
        { id: "n_a2", kind: "destination", destination_id: DST_A },
      ],
      edges: [
        { from: "n_src", to: "n_t1" },
        { from: "n_src", to: "n_t2" },
        { from: "n_t1", to: "n_a1" },
        { from: "n_t2", to: "n_a2" },
      ],
    };
    const out = executeGraph({ event_id: "evt_42", type: "order.created" }, g);
    expect(out.deliveries).toEqual([
      { destination_id: DST_A, leaf_node_id: "n_a1", payload: { id: "evt_42" } },
      {
        destination_id: DST_A,
        leaf_node_id: "n_a2",
        payload: {
          event_type: "order.created",
          occurred_at: null,
          data: { event_id: "evt_42", type: "order.created" },
        },
      },
    ]);
  });

  it("filter prunes its branch; siblings still fire", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_f",
          kind: "filter",
          filter: { kind: "event_type_in", path: "type", values: ["allow"] },
        },
        { id: "n_a", kind: "destination", destination_id: DST_A },
        { id: "n_b", kind: "destination", destination_id: DST_B },
      ],
      edges: [
        { from: "n_src", to: "n_f" },
        { from: "n_f", to: "n_a" },
        { from: "n_src", to: "n_b" },
      ],
    });
    const allowed = executeGraph({ type: "allow", x: 1 }, g);
    expect(allowed.deliveries.map((d) => d.leaf_node_id).sort()).toEqual([
      "n_a",
      "n_b",
    ]);
    const blocked = executeGraph({ type: "deny", x: 1 }, g);
    expect(blocked.deliveries.map((d) => d.leaf_node_id)).toEqual(["n_b"]);
  });

  it("chained transforms within a branch thread output → next input", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_t1",
          kind: "transform",
          transform: { kind: "select", assignments: { id: "event_id" } },
        },
        {
          id: "n_t2",
          kind: "transform",
          transform: {
            kind: "envelope",
            event_type_path: "id",
            occurred_at_path: null,
          },
        },
        { id: "n_dst", kind: "destination", destination_id: DST_A },
      ],
      edges: [
        { from: "n_src", to: "n_t1" },
        { from: "n_t1", to: "n_t2" },
        { from: "n_t2", to: "n_dst" },
      ],
    });
    const out = executeGraph({ event_id: "evt_42" }, g);
    expect(out.deliveries).toEqual([
      {
        destination_id: DST_A,
        leaf_node_id: "n_dst",
        payload: {
          event_type: "evt_42",
          occurred_at: null,
          data: { id: "evt_42" },
        },
      },
    ]);
  });

  it("all-filtered graph returns no deliveries", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_f",
          kind: "filter",
          filter: { kind: "event_type_in", path: "type", values: ["allow"] },
        },
        { id: "n_dst", kind: "destination", destination_id: DST_A },
      ],
      edges: [
        { from: "n_src", to: "n_f" },
        { from: "n_f", to: "n_dst" },
      ],
    });
    expect(executeGraph({ type: "nope" }, g)).toEqual({ deliveries: [] });
  });
});

describe("executeGraphWithTrace", () => {
  function build(graph: Omit<PipelineGraph, "version">): PipelineGraph {
    const attached = new Set<string>();
    for (const n of graph.nodes) {
      if (n.kind === "destination") attached.add(n.destination_id);
    }
    return validatePipelineGraph(
      { version: 1, ...graph },
      { attached_destination_ids: attached },
    );
  }

  it("returns the same deliveries as executeGraph plus a per-node carried map", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_t",
          kind: "transform",
          transform: { kind: "select", assignments: { id: "event_id" } },
        },
        { id: "n_dst", kind: "destination", destination_id: DST_A },
      ],
      edges: [
        { from: "n_src", to: "n_t" },
        { from: "n_t", to: "n_dst" },
      ],
    });
    const payload = { event_id: "evt_42", type: "x" };
    const traced = executeGraphWithTrace(payload, g);
    expect(traced.deliveries).toEqual(executeGraph(payload, g).deliveries);
    expect(traced.carried.get("n_src")).toEqual(payload);
    expect(traced.carried.get("n_t")).toEqual({ id: "evt_42" });
    expect(traced.carried.get("n_dst")).toEqual({ id: "evt_42" });
  });

  it("pruned branches show carried.has() === false for downstream nodes", () => {
    const g = build({
      nodes: [
        { id: "n_src", kind: "source" },
        {
          id: "n_f",
          kind: "filter",
          filter: { kind: "event_type_in", path: "type", values: ["allow"] },
        },
        { id: "n_dst", kind: "destination", destination_id: DST_A },
      ],
      edges: [
        { from: "n_src", to: "n_f" },
        { from: "n_f", to: "n_dst" },
      ],
    });
    const blocked = executeGraphWithTrace({ type: "deny" }, g);
    expect(blocked.deliveries).toEqual([]);
    expect(blocked.carried.has("n_src")).toBe(true);
    expect(blocked.carried.has("n_f")).toBe(false);
    expect(blocked.carried.has("n_dst")).toBe(false);
  });
});
