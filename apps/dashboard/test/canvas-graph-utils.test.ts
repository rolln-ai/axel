import { describe, expect, it } from "vitest";
import type { GeneratedFilter, GeneratedTransform, PipelineGraph } from "@axel/shared";
import {
  DESTINATION_NODE_PREFIX,
  FILTER_NODE_PREFIX,
  SOURCE_NODE_ID,
  TRANSFORM_NODE_PREFIX,
  computeDefaultLayout,
  freshNodeId,
  getIncomingEdges,
  graphsEqual,
  getOutgoingEdges,
  nodeById,
  parseFilterString,
  parseTransformString,
  synthesizeLegacyGraph,
  validateNewEdge,
  wouldCreateCycle,
} from "../app/(app)/routes/[id]/canvas/graphUtils";

describe("freshNodeId", () => {
  it("preserves the requested prefix", () => {
    expect(freshNodeId("n_x_")).toMatch(/^n_x_[a-z0-9_]+$/);
  });

  it("returns a unique id across rapid calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(freshNodeId("n_t_"));
    expect(ids.size).toBe(50);
  });
});

describe("parseFilterString / parseTransformString", () => {
  it("returns null for null / undefined / empty", () => {
    expect(parseFilterString(null)).toBeNull();
    expect(parseFilterString("")).toBeNull();
    expect(parseTransformString(null)).toBeNull();
    expect(parseTransformString("")).toBeNull();
  });

  it("returns null for invalid JSON rather than throwing", () => {
    expect(parseFilterString("not json")).toBeNull();
    expect(parseTransformString("{still: not}")).toBeNull();
  });

  it("returns the parsed value for valid JSON (validation happens later)", () => {
    const f = parseFilterString(JSON.stringify({ kind: "always" }));
    expect(f).toEqual({ kind: "always" });
    const t = parseTransformString(JSON.stringify({ kind: "passthrough" }));
    expect(t).toEqual({ kind: "passthrough" });
  });
});

describe("synthesizeLegacyGraph", () => {
  const destA = { id: "dst_a", name: "A" };
  const destB = { id: "dst_b", name: "B" };

  it("source → destination when there's no filter and no transform", () => {
    const g = synthesizeLegacyGraph({
      filter: null,
      transform: null,
      destinations: [destA],
    });
    expect(g.nodes.map((n) => n.kind)).toEqual(["source", "destination"]);
    expect(g.edges).toEqual([{ from: SOURCE_NODE_ID, to: `${DESTINATION_NODE_PREFIX}dst_a` }]);
  });

  it("treats kind:always filter and kind:passthrough transform as no-ops", () => {
    const g = synthesizeLegacyGraph({
      filter: { kind: "always" } as GeneratedFilter,
      transform: { kind: "passthrough" } as GeneratedTransform,
      destinations: [destA],
    });
    expect(g.nodes.map((n) => n.kind)).toEqual(["source", "destination"]);
  });

  it("inserts a filter node when filter is non-trivial", () => {
    const filter: GeneratedFilter = {
      kind: "event_type_in",
      path: "type",
      values: ["a"],
    };
    const g = synthesizeLegacyGraph({
      filter,
      transform: null,
      destinations: [destA],
    });
    expect(g.nodes.map((n) => n.kind)).toEqual(["source", "filter", "destination"]);
    expect(g.edges).toEqual([
      { from: SOURCE_NODE_ID, to: `${FILTER_NODE_PREFIX}legacy` },
      { from: `${FILTER_NODE_PREFIX}legacy`, to: `${DESTINATION_NODE_PREFIX}dst_a` },
    ]);
  });

  it("inserts a transform node when transform is non-trivial", () => {
    const transform: GeneratedTransform = {
      kind: "select",
      assignments: { event_id: "id" },
    };
    const g = synthesizeLegacyGraph({
      filter: null,
      transform,
      destinations: [destA],
    });
    expect(g.nodes.map((n) => n.kind)).toEqual(["source", "transform", "destination"]);
  });

  it("chains source → filter → transform → fan-out across destinations", () => {
    const g = synthesizeLegacyGraph({
      filter: { kind: "event_type_in", path: "type", values: ["a"] },
      transform: { kind: "select", assignments: { id: "event_id" } },
      destinations: [destA, destB],
    });
    expect(g.nodes.map((n) => n.kind)).toEqual([
      "source",
      "filter",
      "transform",
      "destination",
      "destination",
    ]);
    const transformId = `${TRANSFORM_NODE_PREFIX}legacy`;
    expect(g.edges.filter((e) => e.from === transformId).map((e) => e.to)).toEqual([
      `${DESTINATION_NODE_PREFIX}dst_a`,
      `${DESTINATION_NODE_PREFIX}dst_b`,
    ]);
  });
});

describe("computeDefaultLayout", () => {
  it("returns positions for every node", () => {
    const g = synthesizeLegacyGraph({
      filter: { kind: "event_type_in", path: "type", values: ["a"] },
      transform: null,
      destinations: [{ id: "dst_a", name: "A" }],
    });
    const layout = computeDefaultLayout(g);
    for (const node of g.nodes) {
      expect(layout[node.id]).toBeDefined();
      expect(Number.isFinite(layout[node.id]!.x)).toBe(true);
      expect(Number.isFinite(layout[node.id]!.y)).toBe(true);
    }
  });

  it("destinations land further right than the source", () => {
    const g = synthesizeLegacyGraph({
      filter: null,
      transform: null,
      destinations: [{ id: "dst_a", name: "A" }],
    });
    const layout = computeDefaultLayout(g);
    const srcX = layout[SOURCE_NODE_ID]!.x;
    const dstX = layout[`${DESTINATION_NODE_PREFIX}dst_a`]!.x;
    expect(dstX).toBeGreaterThan(srcX);
  });
});

describe("graphsEqual (canvas dirty comparison)", () => {
  const base: PipelineGraph = {
    version: 1,
    nodes: [
      { id: "a", kind: "source" },
      { id: "b", kind: "destination", destination_id: "dst_x" },
    ],
    edges: [{ from: "a", to: "b" }],
    ui: { a: { x: 0, y: 200 }, b: { x: 260, y: 200 } },
  };

  it("identical graphs are equal", () => {
    expect(graphsEqual(base, structuredClone(base))).toBe(true);
  });

  it("a node drag (ui-only change) marks the graph dirty", () => {
    // Regression: the old comparison stripped `ui`, so drags and "tidy"
    // could never enable Save or arm the beforeunload guard.
    const dragged = structuredClone(base);
    dragged.ui!.b = { x: 300, y: 180 };
    expect(graphsEqual(base, dragged)).toBe(false);
  });

  it("first-ever layout (ui absent → present) marks the graph dirty", () => {
    const withoutUi: PipelineGraph = { ...structuredClone(base), ui: undefined };
    expect(graphsEqual(withoutUi, base)).toBe(false);
    expect(graphsEqual(withoutUi, structuredClone(withoutUi))).toBe(true);
  });

  it("ui key order doesn't matter (no-op tidy stays clean)", () => {
    const reordered = structuredClone(base);
    reordered.ui = { b: { x: 260, y: 200 }, a: { x: 0, y: 200 } };
    expect(graphsEqual(base, reordered)).toBe(true);
  });

  it("structural changes still mark the graph dirty", () => {
    const edited = structuredClone(base);
    edited.edges = [...edited.edges, { from: "a", to: "b" }];
    expect(graphsEqual(base, edited)).toBe(false);
  });
});

describe("nodeById / outgoing / incoming", () => {
  const graph: PipelineGraph = {
    version: 1,
    nodes: [
      { id: "a", kind: "source" },
      { id: "b", kind: "filter", filter: { kind: "always" } },
      { id: "c", kind: "destination", destination_id: "dst_x" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };

  it("nodeById returns the matching node or undefined", () => {
    expect(nodeById(graph, "a")?.kind).toBe("source");
    expect(nodeById(graph, "missing")).toBeUndefined();
  });

  it("getOutgoingEdges returns edges leaving the node", () => {
    expect(getOutgoingEdges(graph, "a")).toEqual([{ from: "a", to: "b" }]);
    expect(getOutgoingEdges(graph, "c")).toEqual([]);
  });

  it("getIncomingEdges returns edges arriving at the node", () => {
    expect(getIncomingEdges(graph, "c")).toEqual([{ from: "b", to: "c" }]);
    expect(getIncomingEdges(graph, "a")).toEqual([]);
  });
});

describe("wouldCreateCycle", () => {
  const chain: PipelineGraph = {
    version: 1,
    nodes: [
      { id: "a", kind: "source" },
      { id: "b", kind: "transform", transform: { kind: "passthrough" } },
      { id: "c", kind: "destination", destination_id: "dst_x" },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ],
  };

  it("self-loop is a cycle", () => {
    expect(wouldCreateCycle(chain, "a", "a")).toBe(true);
  });

  it("adding c → a closes a → b → c → a", () => {
    expect(wouldCreateCycle(chain, "c", "a")).toBe(true);
  });

  it("a forward edge that doesn't close anything is fine", () => {
    expect(wouldCreateCycle(chain, "a", "c")).toBe(false);
  });
});

describe("validateNewEdge", () => {
  const dest: PipelineGraph = {
    version: 1,
    nodes: [
      { id: "src", kind: "source" },
      { id: "t1", kind: "transform", transform: { kind: "passthrough" } },
      { id: "d1", kind: "destination", destination_id: "dst_a" },
      { id: "d2", kind: "destination", destination_id: "dst_b" },
    ],
    edges: [
      { from: "src", to: "t1" },
      { from: "t1", to: "d1" },
    ],
  };

  it("rejects edge to source", () => {
    expect(validateNewEdge(dest, "t1", "src")).toMatch(/Source/);
  });

  it("rejects edge from destination", () => {
    expect(validateNewEdge(dest, "d1", "d2")).toMatch(/Destination/);
  });

  it("rejects fan-in into a non-destination", () => {
    // src → t1 already exists; another edge into t1 is fan-in.
    const withSibling: PipelineGraph = {
      ...dest,
      nodes: [...dest.nodes, { id: "t2", kind: "transform", transform: { kind: "passthrough" } }],
      edges: [...dest.edges, { from: "src", to: "t2" }],
    };
    expect(validateNewEdge(withSibling, "t2", "t1")).toMatch(/multiple incoming/);
  });

  it("rejects duplicate edges (destination targets bypass the single-in rule)", () => {
    // Add a redundant src → d1 to the fixture so re-adding it goes past
    // the single-in check (destinations allow fan-in) and hits the
    // duplicate-edge guard.
    const withParallelEdge: PipelineGraph = {
      ...dest,
      edges: [...dest.edges, { from: "src", to: "d1" }],
    };
    expect(validateNewEdge(withParallelEdge, "src", "d1")).toMatch(/already exists/);
  });

  it("rejects unknown nodes", () => {
    expect(validateNewEdge(dest, "src", "missing")).toMatch(/Unknown/);
  });

  it("rejects self-loops via whichever rule fires first", () => {
    // Self-loop on a non-destination hits the fan-in rule before the
    // cycle check, because t1 already has an incoming edge.
    expect(validateNewEdge(dest, "t1", "t1")).toMatch(/multiple incoming/);
  });

  it("accepts a fresh forward edge between known nodes", () => {
    expect(validateNewEdge(dest, "t1", "d2")).toBeNull();
  });
});
