"use client";

/**
 * Interactive route pipeline canvas — replaces the static RouteFocusCanvas
 * SVG. Built on @xyflow/react. Two modes:
 *
 *   View mode (default):
 *     Read-only graph render. Edge colors reflect 24h delivery health
 *     (preserving the old SVG's legend). Clicking a node opens the
 *     side panel with its config + (when a sample is loaded) per-node
 *     input/output preview computed via @axel/shared `executeGraph`.
 *
 *   Edit mode (gated on canMutate):
 *     Adds a left-side palette ("Add filter / transform / destination").
 *     Edges become draggable; new edges validate against single-in /
 *     no-cycles / fan-in-only-at-destination invariants. Saving writes
 *     a `pipeline_graph` JSON through `savePipelineGraph` with
 *     optimistic concurrency — a stale row pops the conflict modal.
 *
 * The same canvas works for both kinds of route:
 *   - Legacy single-shape routes: we synthesize an equivalent graph
 *     for display. Saving converts the route to a real `pipeline_graph`.
 *   - Already-graphed routes: we render the saved graph directly.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  ConnectionMode,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type OnConnect,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  RouteEngineError,
  executeGraphWithTrace,
  validatePipelineGraph,
  type GeneratedFilter,
  type GeneratedTransform,
  type LeafDelivery,
  type PipelineGraph,
  type PipelineNode,
} from "@axel/shared";
import { NODE_TYPES, type CanvasNodeRuntime } from "./canvas/CanvasNodes";
import { NodeInspector } from "./canvas/NodeInspector";
import { SampleLoader } from "./canvas/SampleLoader";
import {
  DESTINATION_NODE_PREFIX,
  FILTER_NODE_PREFIX,
  TRANSFORM_NODE_PREFIX,
  computeDefaultLayout,
  freshNodeId,
  graphsEqual,
  parseFilterString,
  parseTransformString,
  synthesizeLegacyGraph,
  validateNewEdge,
} from "./canvas/graphUtils";
import { savePipelineGraph, type SavePipelineGraphResult } from "../../../../lib/route-canvas-actions";

export interface RoutePipelineCanvasProps {
  routeId: string;
  routeStatus: "active" | "disabled" | "errored";
  routeUpdatedAt: string;
  initialPipelineGraph: string | null;
  legacyFilter: string | null;
  legacyTransform: string | null;
  source: { id: string; name: string; status: "active" | "disabled" };
  destinations: {
    id: string;
    name: string;
    type: string;
    status: "active" | "disabled";
    success: number;
    retry: number;
    dead: number;
  }[];
  /** Saved per-destination binding blobs, keyed by destination id — lets a
   * BigQuery destination node run a pre-flight compatibility check. */
  bindingsByDestinationId?: Record<string, Record<string, unknown>>;
  canMutate: boolean;
  /** Open directly in edit mode when the operator arrived from a repair CTA. */
  initialEditMode?: boolean;
}

type Health = "idle" | "ok" | "filtered" | "error" | "warning";

export function RoutePipelineCanvas(props: RoutePipelineCanvasProps) {
  // No destinations → nothing meaningful to graph. Synthesizing a graph
  // with only a source would fail validation (graph_no_destinations) and
  // render as a confusing single-node canvas. Show a CTA instead.
  if (props.destinations.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center">
        <h3 className="text-sm font-semibold text-foreground">
          No destinations attached
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          A pipeline needs somewhere to deliver to.{" "}
          <a
            href={`/routes/${props.routeId}?tab=destinations`}
            className="text-foreground underline-offset-2 hover:underline"
          >
            Attach a destination
          </a>{" "}
          to start designing the route.
        </p>
      </div>
    );
  }
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner({
  routeId,
  routeStatus,
  routeUpdatedAt,
  initialPipelineGraph,
  legacyFilter,
  legacyTransform,
  source,
  destinations,
  bindingsByDestinationId,
  canMutate,
  initialEditMode,
}: RoutePipelineCanvasProps) {
  // Build the initial graph from either the saved pipeline_graph (when
  // present) or by synthesizing the equivalent of the legacy shape.
  // Both paths produce a PipelineGraph the UI then renders identically.
  const initialGraph = useMemo<PipelineGraph>(() => {
    const attached = new Set(destinations.map((d) => d.id));
    if (initialPipelineGraph) {
      try {
        const parsed = JSON.parse(initialPipelineGraph) as unknown;
        return validatePipelineGraph(parsed, {
          attached_destination_ids: attached,
        });
      } catch {
        console.warn("[canvas] saved graph failed validation, falling back to legacy");
      }
    }
    return synthesizeLegacyGraph({
      filter: parseFilterString(legacyFilter),
      transform: parseTransformString(legacyTransform),
      destinations,
    });
  }, [initialPipelineGraph, legacyFilter, legacyTransform, destinations]);

  const [graph, setGraph] = useState<PipelineGraph>(initialGraph);
  const [savedGraph, setSavedGraph] = useState<PipelineGraph>(initialGraph);
  const [expectedUpdatedAt, setExpectedUpdatedAt] = useState(routeUpdatedAt);
  const [mode, setMode] = useState<"view" | "edit">(
    initialEditMode && canMutate ? "edit" : "view",
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [sample, setSample] = useState<{ payload: unknown; summary: string } | null>(null);
  const [saveState, setSaveState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "error"; message: string }
    | {
        kind: "stale";
        current: { pipeline_graph: PipelineGraph | null; updated_at: string };
      }
  >({ kind: "idle" });
  const [validationError, setValidationError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rf = useReactFlow();

  // Re-run fitView when the canvas container resizes (e.g. viewport
  // shrinks, sidebar collapses on mobile). React Flow's `fitView` prop
  // only fires once on mount; without this, the layout drifts off-screen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      // Defer one tick so React Flow's internal width measurement has
      // settled before we ask it to re-fit.
      requestAnimationFrame(() => {
        try {
          rf.fitView({ padding: 0.2, duration: 200 });
        } catch {
          // useReactFlow can throw if called before <ReactFlow> mounted;
          // ResizeObserver may fire on the wrapper before that. Safe to
          // swallow — fitView prop on <ReactFlow> will run on mount anyway.
        }
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [rf]);

  // Run the engine over the loaded sample to drive per-node visuals.
  // Pure function; cheap; re-runs whenever the graph or sample changes.
  // Uses executeGraphWithTrace so the canvas reuses the *exact* engine
  // semantics rather than maintaining a parallel simulator.
  const evaluation = useMemo<EvaluationResult>(() => {
    if (sample === null) return { kind: "idle" };
    try {
      // Re-validate before executing so the UI surfaces engine errors
      // (bad path, unknown destination, etc.) the same way the server
      // would.
      const attached = new Set(destinations.map((d) => d.id));
      const valid = validatePipelineGraph(graph, {
        attached_destination_ids: attached,
      });
      const { deliveries, carried } = executeGraphWithTrace(sample.payload, valid);
      return { kind: "ran", carried, deliveries };
    } catch (err) {
      const reason = err instanceof RouteEngineError ? err.reason : "engine_error";
      const message = err instanceof RouteEngineError
        ? "Route evaluation failed. Check the pipeline configuration."
        : "Route evaluation failed.";
      return { kind: "error", reason, message };
    }
  }, [graph, sample, destinations]);

  // Measured node sizes, keyed by node id. React Flow renders every node
  // with `visibility:hidden` until it has measured its box; in controlled
  // mode (`nodes` + `onNodesChange`) that measurement only sticks if the
  // size is carried back into the nodes we hand React Flow. Because we
  // re-derive `rfNodes` from `graph` on every render, we stash the
  // measured dims here and stamp them back on in graphToReactFlow so the
  // nodes never revert to hidden.
  const measuredRef = useRef<Map<string, { width: number; height: number }>>(new Map());

  // Translate the PipelineGraph + evaluation into React Flow nodes & edges.
  const { rfNodes, rfEdges } = useMemo(() => {
    return graphToReactFlow({
      graph,
      source,
      destinations,
      routeStatus,
      evaluation,
      selectedNodeId,
      measured: measuredRef.current,
    });
  }, [graph, source, destinations, routeStatus, evaluation, selectedNodeId]);

  // React Flow controlled state — we keep the *source of truth* in
  // `graph` (PipelineGraph) and mirror it into rfNodes/rfEdges. Position
  // changes (drags) write back into graph.ui.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // Record measured dimensions so re-derived nodes keep their size.
      for (const c of changes) {
        if (c.type === "dimensions" && c.dimensions) {
          measuredRef.current.set(c.id, {
            width: c.dimensions.width,
            height: c.dimensions.height,
          });
        }
      }
      // Only drags / removals mutate graph.ui. Crucially, do NOT call
      // setGraph for the `dimensions` change React Flow fires on initial
      // measurement: that would re-derive the node list mid-measure,
      // strip the freshly-measured size, and leave every node stuck at
      // `visibility:hidden` (blank canvas).
      const positional = changes.filter(
        (c) => c.type === "position" || c.type === "remove",
      );
      if (positional.length === 0) return;
      const updated = applyNodeChanges(positional, rfNodes);
      const positions: Record<string, { x: number; y: number }> = { ...(graph.ui ?? {}) };
      for (const n of updated) {
        positions[n.id] = { x: n.position.x, y: n.position.y };
      }
      setGraph((g) => ({ ...g, ui: positions }));
    },
    [rfNodes, graph.ui],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      if (mode !== "edit") return;
      // Only edge removal flows through here; new edges come via onConnect.
      const removals = changes
        .filter((c) => c.type === "remove")
        .map((c) => (c as Extract<EdgeChange, { type: "remove" }>).id);
      if (removals.length === 0) return;
      setGraph((g) => ({
        ...g,
        edges: g.edges.filter((_, idx) => !removals.includes(rfEdges[idx]?.id ?? "")),
      }));
    },
    [mode, rfEdges],
  );

  const onConnect = useCallback<OnConnect>(
    (connection: Connection) => {
      if (mode !== "edit") return;
      if (!connection.source || !connection.target) return;
      const err = validateNewEdge(graph, connection.source, connection.target);
      if (err) {
        setValidationError(err);
        return;
      }
      setValidationError(null);
      setGraph((g) => ({
        ...g,
        edges: [...g.edges, { from: connection.source!, to: connection.target! }],
      }));
    },
    [graph, mode],
  );

  const updateNode = useCallback((updated: PipelineNode) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === updated.id ? updated : n)),
    }));
  }, []);

  const deleteNode = useCallback((nodeId: string) => {
    setGraph((g) => ({
      ...g,
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
      ui: g.ui ? Object.fromEntries(Object.entries(g.ui).filter(([k]) => k !== nodeId)) : undefined,
    }));
    setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
  }, []);

  // Auto-wire new nodes so the canvas stays in a savable state.
  // Filter / transform: connect from source (output left dangling for the
  // user to wire forward). Destination: connect from the parent of an
  // existing destination if one exists, so the new leaf joins the same
  // chain — otherwise fall back to source.
  const addFilter = useCallback(() => {
    const id = freshNodeId(FILTER_NODE_PREFIX);
    const node: PipelineNode = { id, kind: "filter", filter: { kind: "always" } };
    const positions = { ...(graph.ui ?? {}) };
    positions[id] = { x: 260, y: 200 + (graph.nodes.length % 5) * 30 };
    const sourceId = graph.nodes.find((n) => n.kind === "source")?.id;
    setGraph((g) => ({
      ...g,
      nodes: [...g.nodes, node],
      edges: sourceId ? [...g.edges, { from: sourceId, to: id }] : g.edges,
      ui: positions,
    }));
    setSelectedNodeId(id);
  }, [graph]);

  const addTransform = useCallback(() => {
    const id = freshNodeId(TRANSFORM_NODE_PREFIX);
    const node: PipelineNode = {
      id,
      kind: "transform",
      transform: { kind: "passthrough" },
    };
    setGraph((g) => {
      const positions = { ...(g.ui ?? {}) };
      positions[id] = { x: 520, y: 200 + (g.nodes.length % 5) * 30 };
      const destinationNodeIds = new Set(
        g.nodes.filter((n) => n.kind === "destination").map((n) => n.id),
      );
      const destinationEdges = g.edges.filter((edge) => destinationNodeIds.has(edge.to));
      // A single-destination pipeline has only one unambiguous insertion
      // point. Insert the transform into that chain so it is valid and
      // previewable immediately. Fan-out routes keep the historical
      // source→new-node behavior for manual wiring: silently applying a data
      // conversion to every destination could change payloads that were
      // already healthy.
      if (destinationEdges.length === 1) {
        const parent = destinationEdges[0]!.from;
        return {
          ...g,
          nodes: [...g.nodes, node],
          edges: [
            ...g.edges.filter((edge) => !destinationEdges.includes(edge)),
            { from: parent, to: id },
            ...destinationEdges.map((edge) => ({ from: id, to: edge.to })),
          ],
          ui: positions,
        };
      }

      const sourceId = g.nodes.find((n) => n.kind === "source")?.id;
      return {
        ...g,
        nodes: [...g.nodes, node],
        edges: sourceId ? [...g.edges, { from: sourceId, to: id }] : g.edges,
        ui: positions,
      };
    });
    setSelectedNodeId(id);
  }, []);

  // Destination ids already backed by a node on the canvas. Used to keep
  // the pickers from offering the same destination twice — two nodes on
  // one destination_id double-deliver every matching event, and the
  // server rejects the graph (graph_duplicate_destination) anyway.
  const placedDestinationIds = useMemo(
    () =>
      new Set(
        graph.nodes
          .filter((n): n is Extract<PipelineNode, { kind: "destination" }> => n.kind === "destination")
          .map((n) => n.destination_id),
      ),
    [graph.nodes],
  );

  const addDestinationNode = useCallback(
    (destinationId: string) => {
      if (placedDestinationIds.has(destinationId)) {
        setValidationError(
          "That destination already has a node on the canvas — a destination can only appear once per route.",
        );
        return;
      }
      const id = freshNodeId(DESTINATION_NODE_PREFIX);
      const node: PipelineNode = { id, kind: "destination", destination_id: destinationId };
      const positions = { ...(graph.ui ?? {}) };
      positions[id] = { x: 780, y: 200 + (graph.nodes.length % 5) * 30 };
      // Hook the new destination onto the same upstream chain as the
      // existing destinations (so adding "destination_2" picks up the
      // route's filter/transform automatically). Falls back to source.
      const existingDestination = graph.nodes.find((n) => n.kind === "destination");
      const parentOfDest = existingDestination
        ? graph.edges.find((e) => e.to === existingDestination.id)?.from
        : undefined;
      const parentId = parentOfDest ?? graph.nodes.find((n) => n.kind === "source")?.id;
      setGraph((g) => ({
        ...g,
        nodes: [...g.nodes, node],
        edges: parentId ? [...g.edges, { from: parentId, to: id }] : g.edges,
        ui: positions,
      }));
      setSelectedNodeId(id);
    },
    [graph, placedDestinationIds],
  );

  // Includes `ui` so layout-only edits (drags, "tidy") enable Save and
  // arm the beforeunload guard — the engine ignores `ui`, so saving a
  // layout-only change is semantically a no-op on the server.
  const dirty = useMemo(() => !graphsEqual(graph, savedGraph), [graph, savedGraph]);

  function tidyLayout() {
    setGraph((g) => ({ ...g, ui: computeDefaultLayout(g) }));
  }

  // Auto-dismiss the validation banner after 4s so the canvas doesn't
  // stay loud after a single rejected drag. Re-running the effect on
  // every new error resets the timer.
  useEffect(() => {
    if (!validationError) return;
    const id = window.setTimeout(() => setValidationError(null), 4000);
    return () => window.clearTimeout(id);
  }, [validationError]);

  // Native beforeunload guard when the canvas is dirty in edit mode.
  // Catches browser-back, tab-close, and full reloads — the kinds of
  // actions React Router's client-side nav doesn't see. Side-bar nav
  // within the dashboard does *not* trigger this (the app stays on the
  // same page), but the unsaved-changes toolbar indicator still shows.
  useEffect(() => {
    if (!dirty || mode !== "edit") return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      // Required for legacy compatibility — modern browsers ignore the
      // string and show their own copy, but setting returnValue is what
      // triggers the prompt.
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty, mode]);

  // Edit-mode keyboard: Delete / Backspace removes the selected node (if
  // not the source). Skip when the user is typing in an input/textarea
  // so deleting text in the inspector doesn't accidentally drop a node.
  useEffect(() => {
    if (!canMutate || mode !== "edit") return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tgt = e.target as HTMLElement | null;
      if (
        tgt &&
        (tgt.tagName === "INPUT" ||
          tgt.tagName === "TEXTAREA" ||
          tgt.tagName === "SELECT" ||
          tgt.isContentEditable)
      ) {
        return;
      }
      if (!selectedNodeId) return;
      const node = graph.nodes.find((n) => n.id === selectedNodeId);
      if (!node || node.kind === "source") return;
      e.preventDefault();
      deleteNode(selectedNodeId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canMutate, mode, selectedNodeId, graph.nodes, deleteNode]);

  function discard() {
    setGraph(savedGraph);
    setValidationError(null);
    setSelectedNodeId(null);
  }

  async function attemptSave(overwrite = false) {
    setSaveState({ kind: "saving" });
    setValidationError(null);
    const result: SavePipelineGraphResult = await savePipelineGraph(
      routeId,
      graph,
      overwrite && saveState.kind === "stale" ? saveState.current.updated_at : expectedUpdatedAt,
    );
    if (result.ok) {
      setSavedGraph(result.graph);
      setExpectedUpdatedAt(result.updated_at);
      setGraph(result.graph);
      setSaveState({ kind: "idle" });
      setMode("view");
      return;
    }
    if (result.reason === "stale_save") {
      setSaveState({ kind: "stale", current: result.current });
      return;
    }
    if (result.reason === "validation") {
      setSaveState({
        kind: "error",
        message: `${result.details.reason}: ${result.details.message}`,
      });
      return;
    }
    setSaveState({ kind: "error", message: result.reason });
  }

  // Click-to-fit when the canvas first mounts so layouts that come back
  // from the server land cleanly regardless of viewport.
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canMutate ? (
          mode === "view" ? (
            <button
              type="button"
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
              onClick={() => setMode("edit")}
              aria-label="Enter pipeline edit mode"
            >
              Edit pipeline
            </button>
          ) : (
            <>
              <span className="text-xs font-medium text-foreground">Editing</span>
              <button
                type="button"
                onClick={addFilter}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                + filter
              </button>
              <button
                type="button"
                onClick={addTransform}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
              >
                + transform
              </button>
              <AddDestinationButton
                attachedDestinations={destinations}
                placedDestinationIds={placedDestinationIds}
                onPick={addDestinationNode}
              />
              <button
                type="button"
                onClick={tidyLayout}
                className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                title="Recompute default left-to-right column layout"
              >
                ⊞ tidy
              </button>
              <div className="ml-auto flex items-center gap-2">
                {dirty ? (
                  <small className="text-[11px] text-muted-foreground">unsaved changes</small>
                ) : null}
                <button
                  type="button"
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                  onClick={discard}
                  disabled={!dirty || saveState.kind === "saving"}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  onClick={() => attemptSave()}
                  disabled={!dirty || saveState.kind === "saving"}
                >
                  {saveState.kind === "saving" ? "Saving…" : "Save"}
                </button>
                <button
                  type="button"
                  className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
                  onClick={() => {
                    setMode("view");
                    discard();
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          )
        ) : null}
      </div>

      {validationError ? (
        <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {validationError}
        </div>
      ) : null}

      {saveState.kind === "error" ? (
        <div className="rounded-md border border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Save failed: {saveState.message}
        </div>
      ) : null}

      {saveState.kind === "stale" ? (
        <div className="rounded-md border border-amber-500 bg-amber-500/10 px-3 py-2 text-xs">
          Someone else just saved this route. Your changes haven&apos;t been applied yet.
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2 py-1 text-[11px]"
              onClick={() => {
                if (saveState.kind !== "stale") return;
                if (saveState.current.pipeline_graph) {
                  setGraph(saveState.current.pipeline_graph);
                  setSavedGraph(saveState.current.pipeline_graph);
                }
                setExpectedUpdatedAt(saveState.current.updated_at);
                setSaveState({ kind: "idle" });
              }}
            >
              Reload theirs
            </button>
            <button
              type="button"
              className="rounded-md border border-border bg-background px-2 py-1 text-[11px]"
              onClick={() => attemptSave(true)}
            >
              Overwrite with mine
            </button>
          </div>
        </div>
      ) : null}

      <div
        className="grid gap-3 lg:grid-cols-[1fr_320px]"
        style={{ height: "calc(100dvh - 320px)", minHeight: 520 }}
      >
        <div
          ref={containerRef}
          className="relative h-full min-h-[520px] overflow-hidden rounded-lg border border-border bg-card"
          role="region"
          aria-label={`Pipeline graph for route ${source.name} — ${graph.nodes.length} nodes${
            dirty ? " (unsaved changes)" : ""
          }`}
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            connectionMode={ConnectionMode.Loose}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_event, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            nodesDraggable={canMutate}
            nodesConnectable={mode === "edit"}
            edgesFocusable={mode === "edit"}
            elementsSelectable={true}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <div className="space-y-3 overflow-y-auto pr-1">
          <NodeInspector
            node={graph.nodes.find((n) => n.id === selectedNodeId) ?? null}
            runtime={runtimeFor(selectedNodeId, evaluation)}
            inputSample={inputForNode(selectedNodeId, graph, evaluation, sample?.payload)}
            outputSample={outputForNode(selectedNodeId, evaluation)}
            canEdit={canMutate && mode === "edit"}
            sourceId={source.id}
            attachedDestinations={destinations.map((d) => ({
              id: d.id,
              name: d.name,
              type: d.type,
              binding: bindingsByDestinationId?.[d.id] ?? null,
            }))}
            placedDestinationIds={placedDestinationIds}
            onUpdateNode={updateNode}
            onDeleteNode={deleteNode}
          />
          <SampleLoader
            sourceId={source.id}
            onLoaded={(payload, summary) => setSample({ payload, summary })}
          />
          {sample ? (
            <div className="rounded-md border border-border bg-card px-3 py-2 text-[11px]">
              <div className="text-muted-foreground">Loaded sample</div>
              <div className="font-mono text-foreground">{sample.summary}</div>
              {evaluation.kind === "ran" ? (
                <div className="mt-1 text-muted-foreground">
                  {evaluation.deliveries.length} delivery
                  {evaluation.deliveries.length === 1 ? "" : "ies"} would fire
                </div>
              ) : null}
              {evaluation.kind === "error" ? (
                <div className="mt-1 text-destructive">{evaluation.reason}</div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AddDestinationButton({
  attachedDestinations,
  placedDestinationIds,
  onPick,
}: {
  attachedDestinations: { id: string; name: string; type: string }[];
  placedDestinationIds: Set<string>;
  onPick: (destinationId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (attachedDestinations.length === 0) {
    return (
      <small className="text-[11px] text-muted-foreground">
        Attach destinations on the Destinations tab to add them here.
      </small>
    );
  }
  // A destination can only back one node per route (two nodes would
  // double-deliver), so hide the ones already on the canvas.
  const available = attachedDestinations.filter((d) => !placedDestinationIds.has(d.id));
  if (available.length === 0) {
    return (
      <small className="text-[11px] text-muted-foreground">
        All attached destinations are already on the canvas.
      </small>
    );
  }
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted"
      >
        + destination
      </button>
      {open ? (
        <div className="absolute left-0 z-10 mt-1 w-56 rounded-md border border-border bg-card shadow-lg">
          {available.map((d) => (
            <button
              key={d.id}
              type="button"
              className="block w-full px-2 py-1 text-left text-xs hover:bg-muted"
              onClick={() => {
                onPick(d.id);
                setOpen(false);
              }}
            >
              <span className="font-medium">{d.name}</span>
              <span className="ml-1 text-muted-foreground">{d.type}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Result of evaluating the loaded sample through the graph. `carried` is
// the per-node value map returned by executeGraphWithTrace; `deliveries`
// is the LeafDelivery[] the router would enqueue.
type EvaluationResult =
  | { kind: "idle" }
  | { kind: "ran"; carried: Map<string, unknown>; deliveries: LeafDelivery[] }
  | { kind: "error"; reason: string; message: string };

// ---------------------------------------------------------------------------
// Mapping PipelineGraph → React Flow shapes.
// ---------------------------------------------------------------------------

function graphToReactFlow({
  graph,
  source,
  destinations,
  routeStatus,
  evaluation,
  selectedNodeId,
  measured,
}: {
  graph: PipelineGraph;
  source: { id: string; name: string; status: "active" | "disabled" };
  destinations: RoutePipelineCanvasProps["destinations"];
  routeStatus: "active" | "disabled" | "errored";
  evaluation: EvaluationResult;
  selectedNodeId: string | null;
  measured: Map<string, { width: number; height: number }>;
}): { rfNodes: Node[]; rfEdges: Edge[] } {
  const layout = graph.ui ?? computeDefaultLayout(graph);
  const destById = new Map(destinations.map((d) => [d.id, d]));
  const nodeHealth = nodeHealthMap(graph, evaluation);

  const rfNodes: Node[] = graph.nodes.map((n) => {
    const pos = layout[n.id] ?? { x: 0, y: 0 };
    const health = nodeHealth.get(n.id) ?? "idle";
    const runtime: CanvasNodeRuntime = { health, selected: n.id === selectedNodeId };
    let type: keyof typeof NODE_TYPES = "source";
    let data: Record<string, unknown> = {};
    if (n.kind === "source") {
      type = "source";
      data = {
        kind: "source",
        name: source.name,
        sourceId: source.id,
        statusOk: source.status === "active",
        ...runtime,
      };
    } else if (n.kind === "filter") {
      type = "filter";
      data = {
        kind: "filter",
        summary: filterSummary(n.filter),
        ...runtime,
      };
    } else if (n.kind === "transform") {
      type = "transform";
      data = {
        kind: "transform",
        summary: transformSummary(n.transform),
        ...runtime,
      };
    } else if (n.kind === "destination") {
      type = "destination";
      const d = destById.get(n.destination_id);
      data = {
        kind: "destination",
        name: d?.name ?? n.destination_id,
        type: d?.type ?? "destination",
        statusOk: (d?.status ?? "active") === "active",
        ...runtime,
      };
    }
    const size = measured.get(n.id);
    return {
      id: n.id,
      type,
      position: pos,
      data,
      draggable: true,
      // Carry the measured box back so React Flow keeps the node visible
      // across re-renders instead of resetting it to visibility:hidden.
      ...(size ? { measured: size, width: size.width, height: size.height } : {}),
    };
  });

  const rfEdges: Edge[] = graph.edges.map((e, idx) => {
    const targetNode = graph.nodes.find((n) => n.id === e.to);
    const color =
      targetNode?.kind === "destination"
        ? edgeColorForDestination(targetNode.destination_id, destById, routeStatus, nodeHealth.get(e.to))
        : edgeColorForHealth(nodeHealth.get(e.to) ?? "idle");
    return {
      id: `e_${idx}_${e.from}__${e.to}`,
      source: e.from,
      target: e.to,
      animated: nodeHealth.get(e.to) === "ok",
      style: { stroke: color, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
    };
  });

  return { rfNodes, rfEdges };
}

function nodeHealthMap(graph: PipelineGraph, evaluation: EvaluationResult): Map<string, Health> {
  const out = new Map<string, Health>();
  if (evaluation.kind === "idle") {
    for (const n of graph.nodes) out.set(n.id, "idle");
    return out;
  }
  if (evaluation.kind === "error") {
    for (const n of graph.nodes) out.set(n.id, "error");
    return out;
  }
  for (const n of graph.nodes) {
    out.set(n.id, evaluation.carried.has(n.id) ? "ok" : "filtered");
  }
  return out;
}

function edgeColorForHealth(h: Health): string {
  switch (h) {
    case "ok":
      return "#16a34a";
    case "filtered":
      return "#ca8a04";
    case "error":
      return "#dc2626";
    case "warning":
      return "#ea580c";
    default:
      return "#9ca3af";
  }
}

function edgeColorForDestination(
  destId: string,
  destById: Map<string, RoutePipelineCanvasProps["destinations"][number]>,
  routeStatus: "active" | "disabled" | "errored",
  health: Health | undefined,
): string {
  // When a sample is loaded, show pipeline health (ok/filtered/error).
  // Otherwise fall back to the 24h delivery health, mirroring the
  // legacy SVG's coloring.
  if (health && health !== "idle") return edgeColorForHealth(health);
  const dest = destById.get(destId);
  if (!dest) return "#9ca3af";
  if (routeStatus !== "active" || dest.status !== "active") return "#9ca3af";
  if (dest.success === 0 && dest.retry === 0 && dest.dead === 0) return "#9ca3af";
  if (dest.dead > 0) return "#dc2626";
  if (dest.retry > 0 && dest.success === 0) return "#ca8a04";
  return "#16a34a";
}

function filterSummary(f: GeneratedFilter): string {
  switch (f.kind) {
    case "always":
      return "pass anything";
    case "event_type_in":
      return `${f.path} ∈ {${f.values.slice(0, 2).join(", ")}${f.values.length > 2 ? "…" : ""}}`;
    case "and":
      return `all of (${f.parts.length})`;
    case "or":
      return `any of (${f.parts.length})`;
  }
}

function transformSummary(t: GeneratedTransform): string {
  switch (t.kind) {
    case "passthrough":
      return "pass through";
    case "select":
      return `select ${Object.keys(t.assignments).length} field${
        Object.keys(t.assignments).length === 1 ? "" : "s"
      }`;
    case "coerce":
      return `convert ${t.fields.length} field${t.fields.length === 1 ? "" : "s"}`;
    case "collapse_arrays":
      return `collapse ${t.fields.length} array${t.fields.length === 1 ? "" : "s"}`;
    case "envelope":
      return "wrap in envelope";
    case "jsonb_blob":
      return `jsonb → ${t.column}`;
  }
}

function runtimeFor(
  nodeId: string | null,
  evaluation: EvaluationResult,
): CanvasNodeRuntime | null {
  if (!nodeId) return null;
  if (evaluation.kind === "idle") return { health: "idle" };
  if (evaluation.kind === "error") {
    return { health: "error", detail: evaluation.reason };
  }
  return {
    health: evaluation.carried.has(nodeId) ? "ok" : "filtered",
  };
}

function inputForNode(
  nodeId: string | null,
  graph: PipelineGraph,
  evaluation: EvaluationResult,
  sourcePayload: unknown,
): unknown | undefined {
  if (!nodeId || evaluation.kind !== "ran") return undefined;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;
  if (node.kind === "source") return sourcePayload;
  const incoming = graph.edges.find((e) => e.to === nodeId);
  if (!incoming) return undefined;
  return evaluation.carried.get(incoming.from);
}

function outputForNode(
  nodeId: string | null,
  evaluation: EvaluationResult,
): unknown | undefined {
  if (!nodeId || evaluation.kind !== "ran") return undefined;
  return evaluation.carried.get(nodeId);
}

// Re-export for the page's static fallback (FocusLegend lookup).
export { computeDefaultLayout } from "./canvas/graphUtils";
