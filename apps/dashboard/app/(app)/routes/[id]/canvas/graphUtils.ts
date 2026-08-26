/**
 * Helpers that bridge between the engine's serialized DSL shapes
 * (filter_expression / transform_script / pipeline_graph) and the
 * canvas's runtime UI state. Pure functions only — no React imports
 * so the file is safe in both server and client contexts.
 */
import type {
  GeneratedFilter,
  GeneratedTransform,
  PipelineEdge,
  PipelineGraph,
  PipelineNode,
} from "@axel/shared";

export const SOURCE_NODE_ID = "n_src";
export const FILTER_NODE_PREFIX = "n_f_";
export const TRANSFORM_NODE_PREFIX = "n_t_";
export const DESTINATION_NODE_PREFIX = "n_dst_";

/** Returns a fresh stable id with the given prefix. Random enough that
 *  collisions inside a single canvas session won't happen. */
export function freshNodeId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-4);
  return `${prefix}${ts}_${rand}`;
}

/** Best-effort parse of a serialized DSL string. Returns null on any
 *  failure so the canvas can default to a passthrough. */
export function parseFilterString(s: string | null): GeneratedFilter | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as GeneratedFilter;
  } catch {
    return null;
  }
}

export function parseTransformString(s: string | null): GeneratedTransform | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as GeneratedTransform;
  } catch {
    return null;
  }
}

/** Synthesize a PipelineGraph from a legacy route shape. Used when the
 *  route has no `pipeline_graph` yet but the operator opens the canvas:
 *  we display the equivalent graph so the canvas always has *some*
 *  graph to render. Editing + saving converts the legacy shape into a
 *  real `pipeline_graph` on the server. */
export function synthesizeLegacyGraph(input: {
  filter: GeneratedFilter | null;
  transform: GeneratedTransform | null;
  destinations: { id: string; name: string }[];
}): PipelineGraph {
  const nodes: PipelineNode[] = [{ id: SOURCE_NODE_ID, kind: "source" }];
  const edges: PipelineEdge[] = [];
  let cursor = SOURCE_NODE_ID;

  if (input.filter && input.filter.kind !== "always") {
    const id = `${FILTER_NODE_PREFIX}legacy`;
    nodes.push({ id, kind: "filter", filter: input.filter });
    edges.push({ from: cursor, to: id });
    cursor = id;
  }
  if (input.transform && input.transform.kind !== "passthrough") {
    const id = `${TRANSFORM_NODE_PREFIX}legacy`;
    nodes.push({ id, kind: "transform", transform: input.transform });
    edges.push({ from: cursor, to: id });
    cursor = id;
  }
  for (const dst of input.destinations) {
    const id = `${DESTINATION_NODE_PREFIX}${dst.id}`;
    nodes.push({ id, kind: "destination", destination_id: dst.id });
    edges.push({ from: cursor, to: id });
  }

  // If the route has no destinations the graph is incomplete; the caller
  // should treat the empty array as "no graph to render" — but we still
  // return the source so the canvas can show a starting state.
  return { version: 1, nodes, edges };
}

/** Default UI layout — left-to-right columns by node kind. Used when
 *  the graph has no persisted `ui` positions, e.g. for legacy routes or
 *  the first time someone opens the canvas after Phase 2 ships. */
export function computeDefaultLayout(graph: PipelineGraph): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  const COL = 260;
  const ROW = 110;

  // Bucket nodes by column based on topological distance from source.
  // Simple BFS — branches that diverge end up on adjacent columns.
  const incoming = new Map<string, number>();
  for (const n of graph.nodes) incoming.set(n.id, 0);
  for (const e of graph.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);

  const distFromSource = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.kind === "source") distFromSource.set(n.id, 0);
  }
  const queue = [...distFromSource.keys()];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = distFromSource.get(cur)!;
    for (const e of graph.edges) {
      if (e.from !== cur) continue;
      const cur_d = distFromSource.get(e.to);
      if (cur_d === undefined || cur_d < d + 1) {
        distFromSource.set(e.to, d + 1);
        queue.push(e.to);
      }
    }
  }

  // Group by column, then stack vertically. Destinations get pushed to
  // the rightmost column so a chain of transforms with multiple leaves
  // looks like Source ──> T1 ──> T2 ──> Dest{A,B}.
  const maxDist = Math.max(0, ...Array.from(distFromSource.values()));
  const cols = new Map<number, string[]>();
  for (const n of graph.nodes) {
    let col = distFromSource.get(n.id) ?? 0;
    if (n.kind === "destination") col = maxDist;
    const arr = cols.get(col) ?? [];
    arr.push(n.id);
    cols.set(col, arr);
  }
  for (const [col, ids] of cols.entries()) {
    const offset = -((ids.length - 1) * ROW) / 2;
    ids.forEach((id, i) => {
      out[id] = { x: col * COL, y: offset + i * ROW + 200 };
    });
  }
  return out;
}

/** Structural equality for two pipeline graphs, *including* the `ui`
 *  layout positions. Drives the canvas's dirty flag: node drags and the
 *  "tidy" button only touch `ui`, so a comparison that strips it would
 *  leave layout-only edits permanently unsavable (Save disabled, no
 *  beforeunload warning). The engine ignores `ui` and savePipelineGraph
 *  validates + persists it verbatim, so a layout-only save is
 *  semantically a no-op. Layouts compare key-order-insensitively so a
 *  "tidy" that recomputes identical positions doesn't false-dirty. */
export function graphsEqual(a: PipelineGraph, b: PipelineGraph): boolean {
  const { ui: uiA, ...restA } = a;
  const { ui: uiB, ...restB } = b;
  if (JSON.stringify(restA) !== JSON.stringify(restB)) return false;
  return layoutsEqual(uiA, uiB);
}

function layoutsEqual(a: PipelineGraph["ui"], b: PipelineGraph["ui"]): boolean {
  const aEntries = Object.entries(a ?? {});
  const bLayout = b ?? {};
  if (aEntries.length !== Object.keys(bLayout).length) return false;
  return aEntries.every(([id, pos]) => {
    const other = bLayout[id];
    return other !== undefined && other.x === pos.x && other.y === pos.y;
  });
}

export function nodeById(graph: PipelineGraph, id: string): PipelineNode | undefined {
  return graph.nodes.find((n) => n.id === id);
}

export function getOutgoingEdges(graph: PipelineGraph, nodeId: string): PipelineEdge[] {
  return graph.edges.filter((e) => e.from === nodeId);
}

export function getIncomingEdges(graph: PipelineGraph, nodeId: string): PipelineEdge[] {
  return graph.edges.filter((e) => e.to === nodeId);
}

/** Returns true if adding the edge `from → to` would introduce a cycle
 *  in the current graph. Used to short-circuit illegal canvas drops. */
export function wouldCreateCycle(graph: PipelineGraph, from: string, to: string): boolean {
  if (from === to) return true;
  // BFS from `to`. If we reach `from`, adding `from → to` closes a cycle.
  const visited = new Set<string>([to]);
  const queue = [to];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== cur) continue;
      if (e.to === from) return true;
      if (visited.has(e.to)) continue;
      visited.add(e.to);
      queue.push(e.to);
    }
  }
  return false;
}

/** Same connection validation as the server-side validator, but cheap
 *  enough to call on every drag. Returns null if the connection is
 *  valid, or a short error message if not. */
export function validateNewEdge(
  graph: PipelineGraph,
  from: string,
  to: string,
): string | null {
  const fromNode = nodeById(graph, from);
  const toNode = nodeById(graph, to);
  if (!fromNode || !toNode) return "Unknown node.";
  if (toNode.kind === "source") return "Source cannot have an incoming edge.";
  if (fromNode.kind === "destination") return "Destination cannot have an outgoing edge.";
  // Single-in invariant for non-destination nodes.
  if (toNode.kind !== "destination") {
    const existing = getIncomingEdges(graph, to);
    if (existing.length > 0) {
      return "Only destinations can have multiple incoming edges.";
    }
  }
  if (wouldCreateCycle(graph, from, to)) return "Adding this edge would create a cycle.";
  // Duplicate edge guard.
  if (graph.edges.some((e) => e.from === from && e.to === to)) return "Edge already exists.";
  return null;
}
