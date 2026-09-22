/**
 * Declarative route engine: a tiny, eval-free filter + transform runtime
 * that runs identically in Node and CF Workers.
 *
 * Lives in @axel/shared so the dashboard (which generates these
 * declarations) and apps/router-edge (which runs them in the hot path)
 * share a single source of truth. Same DSL stays evaluable in any future
 * Node-runtime router too.
 *
 * Safety properties:
 *   - No eval, no Function, no dynamic code. The transform IS data.
 *   - No prototype pollution surface: setPath writes only own properties
 *     into a fresh object the caller owns.
 *   - Array recursion is `[0]`-bounded — never walks a million-item list.
 *   - Path resolution is bounded by `MAX_PATH_DEPTH` to keep memory + CPU
 *     bounded regardless of input.
 */

export type ScalarCoercionTarget = "string" | "integer" | "number" | "boolean";
export type IntegerRounding = "round" | "floor" | "ceil" | "truncate";
export type ArrayCollapseFormat = "join" | "json";

export interface ScalarCoercion {
  /** Dotted JSON path. `items[].amount` applies to every array item. */
  path: string;
  to: ScalarCoercionTarget;
  /** Required for integer conversions so decimal handling is never implicit. */
  rounding?: IntegerRounding;
}

export interface ArrayCollapse {
  /** Dotted JSON path to the array. Existing strings are already collapsed.
   * `items[].tags` handles nested arrays. */
  path: string;
  /** Join scalar members, or preserve the complete array as JSON text. */
  format: ArrayCollapseFormat;
  /** Used only by `join`; defaults to a comma followed by a space. */
  separator?: string;
}

export type GeneratedTransform =
  | { kind: "passthrough" }
  | { kind: "select"; assignments: Record<string, string> }
  | { kind: "coerce"; fields: ScalarCoercion[] }
  | { kind: "collapse_arrays"; fields: ArrayCollapse[] }
  | {
      kind: "envelope";
      event_type_path: string | null;
      occurred_at_path: string | null;
    }
  | { kind: "jsonb_blob"; column: string };

export type GeneratedFilter =
  | { kind: "always" }
  | { kind: "event_type_in"; path: string; values: string[] }
  | { kind: "and"; parts: GeneratedFilter[] }
  | { kind: "or"; parts: GeneratedFilter[] };

const MAX_PATH_DEPTH = 64;

export class RouteEngineError extends Error {
  readonly reason: string;
  constructor(reason: string, detail?: string) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "RouteEngineError";
    this.reason = reason;
  }
}

/**
 * Validate + parse a serialized transform. Throws a `RouteEngineError`
 * with a stable `reason` so the edge router can map it to a structured
 * dead-letter category.
 */
export function parseTransform(serialized: string): GeneratedTransform {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (err) {
    throw new RouteEngineError(
      "transform_invalid_json",
      err instanceof Error ? err.message : String(err),
    );
  }
  return validateTransform(raw);
}

export function parseFilter(serialized: string): GeneratedFilter {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (err) {
    throw new RouteEngineError(
      "filter_invalid_json",
      err instanceof Error ? err.message : String(err),
    );
  }
  return validateFilter(raw);
}

export function validateTransform(value: unknown): GeneratedTransform {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouteEngineError("transform_not_object");
  }
  const obj = value as Record<string, unknown>;
  switch (obj.kind) {
    case "passthrough":
      return { kind: "passthrough" };
    case "select": {
      const assignments = obj.assignments;
      if (!assignments || typeof assignments !== "object" || Array.isArray(assignments)) {
        throw new RouteEngineError("transform_select_missing_assignments");
      }
      const safe: Record<string, string> = {};
      for (const [k, v] of Object.entries(assignments)) {
        if (typeof v !== "string") {
          throw new RouteEngineError("transform_select_non_string_path", k);
        }
        if (!isSafePath(v) || !isSafePath(k)) {
          throw new RouteEngineError("transform_unsafe_path", `${k}=${v}`);
        }
        safe[k] = v;
      }
      return { kind: "select", assignments: safe };
    }
    case "coerce": {
      if (!Array.isArray(obj.fields) || obj.fields.length === 0 || obj.fields.length > 32) {
        throw new RouteEngineError("transform_coerce_bad_fields");
      }
      const fields: ScalarCoercion[] = obj.fields.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RouteEngineError("transform_coerce_field_not_object", String(index));
        }
        const field = raw as Record<string, unknown>;
        if (typeof field.path !== "string" || !isSafePath(field.path)) {
          throw new RouteEngineError("transform_coerce_bad_path", String(field.path));
        }
        if (
          field.to !== "string" &&
          field.to !== "integer" &&
          field.to !== "number" &&
          field.to !== "boolean"
        ) {
          throw new RouteEngineError("transform_coerce_bad_target", String(field.to));
        }
        if (field.to === "integer") {
          if (
            field.rounding !== "round" &&
            field.rounding !== "floor" &&
            field.rounding !== "ceil" &&
            field.rounding !== "truncate"
          ) {
            throw new RouteEngineError("transform_coerce_integer_needs_rounding", field.path);
          }
          return { path: field.path, to: field.to, rounding: field.rounding };
        }
        return { path: field.path, to: field.to };
      });
      return { kind: "coerce", fields };
    }
    case "collapse_arrays": {
      if (!Array.isArray(obj.fields) || obj.fields.length === 0 || obj.fields.length > 32) {
        throw new RouteEngineError("transform_collapse_arrays_bad_fields");
      }
      const fields: ArrayCollapse[] = obj.fields.map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          throw new RouteEngineError("transform_collapse_array_field_not_object", String(index));
        }
        const field = raw as Record<string, unknown>;
        if (
          typeof field.path !== "string" ||
          !isSafePath(field.path) ||
          field.path.endsWith("[]")
        ) {
          throw new RouteEngineError("transform_collapse_array_bad_path", String(field.path));
        }
        if (field.format !== "join" && field.format !== "json") {
          throw new RouteEngineError("transform_collapse_array_bad_format", String(field.format));
        }
        if (field.format === "join") {
          const separator = field.separator === undefined ? ", " : field.separator;
          if (typeof separator !== "string" || separator.length > 32) {
            throw new RouteEngineError("transform_collapse_array_bad_separator", field.path);
          }
          return { path: field.path, format: field.format, separator };
        }
        return { path: field.path, format: field.format };
      });
      return { kind: "collapse_arrays", fields };
    }
    case "envelope":
      return {
        kind: "envelope",
        event_type_path:
          typeof obj.event_type_path === "string" ? obj.event_type_path : null,
        occurred_at_path:
          typeof obj.occurred_at_path === "string" ? obj.occurred_at_path : null,
      };
    case "jsonb_blob": {
      const col = obj.column;
      if (typeof col !== "string" || col.length === 0 || col.length > 64) {
        throw new RouteEngineError("transform_jsonb_blob_bad_column");
      }
      return { kind: "jsonb_blob", column: col };
    }
    default:
      throw new RouteEngineError("transform_unknown_kind", String(obj.kind));
  }
}

export function validateFilter(value: unknown): GeneratedFilter {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouteEngineError("filter_not_object");
  }
  const obj = value as Record<string, unknown>;
  switch (obj.kind) {
    case "always":
      return { kind: "always" };
    case "event_type_in": {
      if (typeof obj.path !== "string" || !isSafePath(obj.path)) {
        throw new RouteEngineError("filter_event_type_in_bad_path");
      }
      const values = Array.isArray(obj.values)
        ? obj.values.filter((v): v is string => typeof v === "string")
        : [];
      if (values.length === 0) {
        throw new RouteEngineError("filter_event_type_in_empty_values");
      }
      return { kind: "event_type_in", path: obj.path, values };
    }
    case "and": {
      if (!Array.isArray(obj.parts)) {
        throw new RouteEngineError("filter_and_missing_parts");
      }
      // Cap recursion at 32 nested levels — well above anything we'd
      // realistically generate, well below any reasonable engine.
      if (obj.parts.length > 32) {
        throw new RouteEngineError("filter_and_too_many_parts");
      }
      if (obj.parts.length === 0) {
        throw new RouteEngineError("filter_and_empty_parts");
      }
      return { kind: "and", parts: obj.parts.map(validateFilter) };
    }
    case "or": {
      if (!Array.isArray(obj.parts)) {
        throw new RouteEngineError("filter_or_missing_parts");
      }
      if (obj.parts.length > 32) {
        throw new RouteEngineError("filter_or_too_many_parts");
      }
      if (obj.parts.length === 0) {
        throw new RouteEngineError("filter_or_empty_parts");
      }
      return { kind: "or", parts: obj.parts.map(validateFilter) };
    }
    default:
      throw new RouteEngineError("filter_unknown_kind", String(obj.kind));
  }
}

function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  // Allow alphanumeric, dot, underscore, hyphen, and the [] array marker.
  // Blocks $/prototype/__proto__/constructor and any control characters.
  if (!/^[A-Za-z0-9._\-[\]]+$/.test(path)) return false;
  // Reject the path components we'd never want to traverse.
  const parts = path.split(".");
  if (parts.length > MAX_PATH_DEPTH) return false;
  for (const p of parts) {
    const bare = p.replace(/\[\]$/, "");
    if (bare === "__proto__" || bare === "constructor" || bare === "prototype") {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export function runTransform(payload: unknown, transform: GeneratedTransform): unknown {
  switch (transform.kind) {
    case "passthrough":
      return payload;
    case "select": {
      const out: Record<string, unknown> = Object.create(null);
      for (const [outPath, srcPath] of Object.entries(transform.assignments)) {
        setPath(out, outPath, readPath(payload, srcPath));
      }
      return out;
    }
    case "coerce": {
      const out = cloneJsonLike(payload);
      for (const field of transform.fields) {
        coercePath(out, field.path, field);
      }
      return out;
    }
    case "collapse_arrays": {
      const out = cloneJsonLike(payload);
      for (const field of transform.fields) {
        collapseArrayPath(out, field.path, field);
      }
      return out;
    }
    case "envelope":
      return {
        event_type: transform.event_type_path
          ? readPath(payload, transform.event_type_path)
          : null,
        occurred_at: transform.occurred_at_path
          ? readPath(payload, transform.occurred_at_path)
          : null,
        data: payload,
      };
    case "jsonb_blob":
      return { [transform.column]: payload };
  }
}

function cloneJsonLike(value: unknown, depth = 0): unknown {
  if (depth > MAX_PATH_DEPTH) {
    throw new RouteEngineError("transform_coerce_payload_too_deep");
  }
  if (Array.isArray(value)) return value.map((item) => cloneJsonLike(item, depth + 1));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = cloneJsonLike(child, depth + 1);
    }
    return out;
  }
  return value;
}

function coercePath(root: unknown, path: string, field: ScalarCoercion): void {
  const parts = path.split(".");
  const visit = (node: unknown, index: number): void => {
    if (node === null || node === undefined || index >= parts.length) return;
    const part = parts[index]!;
    const isArray = part.endsWith("[]");
    const key = isArray ? part.slice(0, -2) : part;
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new RouteEngineError("transform_coerce_path_type", path);
    }
    const record = node as Record<string, unknown>;
    if (!Object.hasOwn(record, key)) return;
    const current = record[key];

    if (isArray) {
      if (current === null || current === undefined) return;
      if (!Array.isArray(current)) {
        throw new RouteEngineError("transform_coerce_expected_array", path);
      }
      if (index === parts.length - 1) {
        for (let i = 0; i < current.length; i += 1) {
          if (current[i] !== null && current[i] !== undefined) {
            current[i] = coerceScalar(current[i], field);
          }
        }
      } else {
        for (const item of current) visit(item, index + 1);
      }
      return;
    }

    if (index === parts.length - 1) {
      if (current !== null && current !== undefined) {
        record[key] = coerceScalar(current, field);
      }
      return;
    }
    visit(current, index + 1);
  };
  visit(root, 0);
}

function coerceScalar(value: unknown, field: ScalarCoercion): string | number | boolean {
  const fail = (): never => {
    const rounding = field.to === "integer" ? ` (${field.rounding})` : "";
    throw new RouteEngineError(
      "transform_coerce_failed",
      `${field.path} -> ${field.to}${rounding}; received ${scalarType(value)}`,
    );
  };

  switch (field.to) {
    case "string":
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
      return fail();
    case "number": {
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return fail();
    }
    case "integer": {
      let parsed: number;
      if (typeof value === "number") parsed = value;
      else if (typeof value === "string" && value.trim() !== "") parsed = Number(value);
      else return fail();
      if (!Number.isFinite(parsed)) return fail();
      switch (field.rounding) {
        case "round": return Math.round(parsed);
        case "floor": return Math.floor(parsed);
        case "ceil": return Math.ceil(parsed);
        case "truncate": return Math.trunc(parsed);
        default: return fail();
      }
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === 1 || (typeof value === "string" && value.toLowerCase() === "true")) return true;
      if (value === 0 || (typeof value === "string" && value.toLowerCase() === "false")) return false;
      return fail();
  }
}

function collapseArrayPath(root: unknown, path: string, field: ArrayCollapse): void {
  const parts = path.split(".");
  const visit = (node: unknown, index: number): void => {
    if (node === null || node === undefined || index >= parts.length) return;
    const part = parts[index]!;
    const traversesArray = part.endsWith("[]");
    const key = traversesArray ? part.slice(0, -2) : part;
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new RouteEngineError("transform_collapse_array_path_type", path);
    }
    const record = node as Record<string, unknown>;
    if (!Object.hasOwn(record, key)) return;
    const current = record[key];

    if (traversesArray) {
      if (current === null || current === undefined) return;
      if (!Array.isArray(current)) {
        throw new RouteEngineError("transform_collapse_array_expected_array", path);
      }
      for (const item of current) visit(item, index + 1);
      return;
    }

    if (index === parts.length - 1) {
      if (current === null || current === undefined) return;
      // Repair transforms run on mixed-shape events and on replay. A string
      // already satisfies the target shape; preserve it without encoding twice.
      if (typeof current === "string") return;
      if (!Array.isArray(current)) {
        throw new RouteEngineError("transform_collapse_array_expected_array", path);
      }
      record[key] = collapseArray(current, field);
      return;
    }
    visit(current, index + 1);
  };
  visit(root, 0);
}

function collapseArray(value: unknown[], field: ArrayCollapse): string {
  if (field.format === "json") {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
    throw new RouteEngineError("transform_collapse_array_failed", `${field.path} -> JSON text`);
  }
  const values = value.map((item) => {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      return String(item);
    }
    throw new RouteEngineError(
      "transform_collapse_array_failed",
      `${field.path} -> joined text; received ${scalarType(item)} member`,
    );
  });
  return values.join(field.separator ?? ", ");
}

function scalarType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "decimal";
  return typeof value;
}

export function runFilter(payload: unknown, filter: GeneratedFilter): boolean {
  switch (filter.kind) {
    case "always":
      return true;
    case "event_type_in": {
      const v = readPath(payload, filter.path);
      return filter.values.includes(typeof v === "string" ? v : String(v));
    }
    case "and":
      return filter.parts.every((p) => runFilter(payload, p));
    case "or":
      return filter.parts.some((p) => runFilter(payload, p));
  }
}

function readPath(value: unknown, path: string): unknown {
  if (!path || path === "$") return value;
  const parts = path.split(".");
  if (parts.length > MAX_PATH_DEPTH) return undefined;
  let cur: unknown = value;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    const key = part.replace(/\[\]$/, "");
    if (Array.isArray(cur)) {
      cur = cur[0];
      if (key === "") continue;
    }
    if (cur === null || typeof cur !== "object") return undefined;
    // Hop only own enumerable own props — never walk the prototype chain.
    if (!Object.hasOwn(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  if (parts.length > MAX_PATH_DEPTH) return;
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!.replace(/\[\]$/, "");
    if (key === "__proto__" || key === "constructor" || key === "prototype") return;
    const existing = cur[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      cur = existing as Record<string, unknown>;
    } else {
      const next: Record<string, unknown> = Object.create(null);
      cur[key] = next;
      cur = next;
    }
  }
  const lastKey = parts[parts.length - 1]!.replace(/\[\]$/, "");
  if (lastKey === "__proto__" || lastKey === "constructor" || lastKey === "prototype") return;
  cur[lastKey] = value;
}

// ---------------------------------------------------------------------------
// Pipeline graph (DAG): the route engine's per-event execution model.
//
// A route's pipeline_graph (when non-null) describes a DAG of operations
// that runs over each event:
//   - exactly one Source node (no incoming, ≥1 outgoing)
//   - 0..N Filter nodes (1 incoming, ≥1 outgoing; rejecting prunes its branch)
//   - 0..N Transform nodes (1 incoming, ≥1 outgoing; applies a GeneratedTransform)
//   - 1..N Destination nodes (≥1 incoming, no outgoing; emits a delivery per parent)
//
// Fan-out is allowed at any non-destination node (one payload, many downstream).
// Fan-in is allowed only at destination nodes (each parent edge → one delivery).
// No cycles. The execution model is pure: same input + same graph → same output.
// ---------------------------------------------------------------------------

const MAX_GRAPH_NODES = 64;
const MAX_GRAPH_OUTGOING_EDGES = 8;
const MAX_NODE_ID_LEN = 64;

export type PipelineNode =
  | { id: string; kind: "source" }
  | { id: string; kind: "filter"; filter: GeneratedFilter }
  | { id: string; kind: "transform"; transform: GeneratedTransform }
  | { id: string; kind: "destination"; destination_id: string };

export interface PipelineEdge {
  from: string;
  to: string;
}

export interface PipelineGraph {
  version: 1;
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  /** Persisted layout positions, keyed by node id. UI-only; engine ignores. */
  ui?: Record<string, { x: number; y: number }>;
}

export interface LeafDelivery {
  destination_id: string;
  leaf_node_id: string;
  payload: unknown;
}

export interface ValidatePipelineGraphContext {
  /** Destination ids attached to this route (route_destinations join). */
  attached_destination_ids: Set<string>;
  /**
   * Tolerate two destination nodes sharing a destination_id. Persist paths
   * must reject the shape (it double-delivers), but delivery-time and other
   * parses of already-stored graphs need to accept a legacy row that predates
   * the guard — rejecting there would dead-letter every event on the route.
   */
  allow_duplicate_destination_nodes?: boolean;
}

function isSafeNodeId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= MAX_NODE_ID_LEN &&
    /^[A-Za-z0-9._\-]+$/.test(id)
  );
}

export function parsePipelineGraph(
  serialized: string,
  ctx: ValidatePipelineGraphContext,
): PipelineGraph {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch (err) {
    throw new RouteEngineError(
      "graph_invalid_json",
      err instanceof Error ? err.message : String(err),
    );
  }
  return validatePipelineGraph(raw, ctx);
}

export function validatePipelineGraph(
  value: unknown,
  ctx: ValidatePipelineGraphContext,
): PipelineGraph {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RouteEngineError("graph_not_object");
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new RouteEngineError("graph_unsupported_version", String(obj.version));
  }
  if (!Array.isArray(obj.nodes)) {
    throw new RouteEngineError("graph_missing_nodes");
  }
  if (!Array.isArray(obj.edges)) {
    throw new RouteEngineError("graph_missing_edges");
  }
  if (obj.nodes.length === 0) {
    throw new RouteEngineError("graph_no_nodes");
  }
  if (obj.nodes.length > MAX_GRAPH_NODES) {
    throw new RouteEngineError("graph_too_many_nodes", String(obj.nodes.length));
  }

  // Validate nodes; build id → node map.
  const nodesById = new Map<string, PipelineNode>();
  const validatedNodes: PipelineNode[] = [];
  for (const raw of obj.nodes) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RouteEngineError("graph_node_not_object");
    }
    const n = raw as Record<string, unknown>;
    if (!isSafeNodeId(n.id)) {
      throw new RouteEngineError("graph_node_id_bad", String(n.id));
    }
    if (nodesById.has(n.id)) {
      throw new RouteEngineError("graph_duplicate_node_id", n.id);
    }
    let validated: PipelineNode;
    switch (n.kind) {
      case "source":
        validated = { id: n.id, kind: "source" };
        break;
      case "filter":
        validated = {
          id: n.id,
          kind: "filter",
          filter: validateFilter(n.filter),
        };
        break;
      case "transform":
        validated = {
          id: n.id,
          kind: "transform",
          transform: validateTransform(n.transform),
        };
        break;
      case "destination": {
        if (typeof n.destination_id !== "string" || n.destination_id.length === 0) {
          throw new RouteEngineError("graph_destination_id_bad", String(n.destination_id));
        }
        if (!ctx.attached_destination_ids.has(n.destination_id)) {
          throw new RouteEngineError("graph_destination_not_attached", n.destination_id);
        }
        validated = {
          id: n.id,
          kind: "destination",
          destination_id: n.destination_id,
        };
        break;
      }
      default:
        throw new RouteEngineError("graph_invalid_node_kind", String(n.kind));
    }
    nodesById.set(validated.id, validated);
    validatedNodes.push(validated);
  }

  // Exactly one source.
  const sources = validatedNodes.filter((n) => n.kind === "source");
  if (sources.length === 0) throw new RouteEngineError("graph_no_source");
  if (sources.length > 1) throw new RouteEngineError("graph_multiple_sources");
  const sourceId = sources[0]!.id;

  // At least one destination.
  const destinations = validatedNodes.filter(
    (n): n is Extract<PipelineNode, { kind: "destination" }> => n.kind === "destination",
  );
  if (destinations.length === 0) throw new RouteEngineError("graph_no_destinations");

  // Each destination may back at most one node. Two destination nodes
  // sharing a destination_id would silently double-deliver: the router
  // enqueues one delivery per leaf node, and `deliveryIdempotencyKey`
  // deliberately includes leaf_node_id, so the duplicates never dedupe.
  if (!ctx.allow_duplicate_destination_nodes) {
    const nodeIdByDestinationId = new Map<string, string>();
    for (const node of destinations) {
      const prior = nodeIdByDestinationId.get(node.destination_id);
      if (prior !== undefined) {
        throw new RouteEngineError(
          "graph_duplicate_destination",
          `${node.destination_id} (nodes ${prior}, ${node.id})`,
        );
      }
      nodeIdByDestinationId.set(node.destination_id, node.id);
    }
  }

  // Validate edges; build adjacency.
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodesById.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  const validatedEdges: PipelineEdge[] = [];
  for (const raw of obj.edges) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new RouteEngineError("graph_edge_not_object");
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.from !== "string" || typeof e.to !== "string") {
      throw new RouteEngineError("graph_edge_endpoint_bad");
    }
    if (!nodesById.has(e.from) || !nodesById.has(e.to)) {
      throw new RouteEngineError("graph_edge_dangles", `${e.from}->${e.to}`);
    }
    if (e.from === e.to) {
      throw new RouteEngineError("graph_self_loop", e.from);
    }
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
    validatedEdges.push({ from: e.from, to: e.to });
  }

  // Per-node edge invariants.
  for (const node of validatedNodes) {
    const outCount = outgoing.get(node.id)!.length;
    const inCount = incoming.get(node.id)!.length;
    if (node.kind === "source") {
      if (inCount > 0) throw new RouteEngineError("graph_source_has_incoming", node.id);
      if (outCount === 0) throw new RouteEngineError("graph_source_no_outgoing", node.id);
      if (outCount > MAX_GRAPH_OUTGOING_EDGES) {
        throw new RouteEngineError("graph_too_many_edges_from_node", node.id);
      }
    } else if (node.kind === "destination") {
      if (outCount > 0) throw new RouteEngineError("graph_destination_has_outgoing", node.id);
      if (inCount === 0) throw new RouteEngineError("graph_destination_no_incoming", node.id);
    } else {
      // filter or transform — single-in, ≥1 out, ≤MAX_OUT out
      if (inCount !== 1) throw new RouteEngineError("graph_fan_in_non_destination", node.id);
      if (outCount === 0) throw new RouteEngineError("graph_dangling_node", node.id);
      if (outCount > MAX_GRAPH_OUTGOING_EDGES) {
        throw new RouteEngineError("graph_too_many_edges_from_node", node.id);
      }
    }
  }

  // Cycle detection (colored DFS).
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of nodesById.keys()) color.set(id, WHITE);
  function dfs(nodeId: string): void {
    color.set(nodeId, GRAY);
    for (const next of outgoing.get(nodeId)!) {
      const c = color.get(next);
      if (c === GRAY) throw new RouteEngineError("graph_cycle", `${nodeId}->${next}`);
      if (c === WHITE) dfs(next);
    }
    color.set(nodeId, BLACK);
  }
  for (const id of nodesById.keys()) {
    if (color.get(id) === WHITE) dfs(id);
  }

  // Reachability from source.
  const reachableFromSource = new Set<string>();
  {
    const queue: string[] = [sourceId];
    reachableFromSource.add(sourceId);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of outgoing.get(cur)!) {
        if (!reachableFromSource.has(next)) {
          reachableFromSource.add(next);
          queue.push(next);
        }
      }
    }
  }
  for (const id of nodesById.keys()) {
    if (!reachableFromSource.has(id)) {
      throw new RouteEngineError("graph_orphan_node", id);
    }
  }

  // Every non-destination node must reach at least one destination.
  const reachesDestination = new Set<string>();
  {
    const queue: string[] = destinations.map((d) => d.id);
    for (const id of queue) reachesDestination.add(id);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const prev of incoming.get(cur)!) {
        if (!reachesDestination.has(prev)) {
          reachesDestination.add(prev);
          queue.push(prev);
        }
      }
    }
  }
  for (const node of validatedNodes) {
    if (node.kind !== "destination" && !reachesDestination.has(node.id)) {
      throw new RouteEngineError("graph_orphan_node", node.id);
    }
  }

  // UI positions — optional, lenient. Drop unknown ids; preserve known.
  let ui: Record<string, { x: number; y: number }> | undefined;
  if (obj.ui && typeof obj.ui === "object" && !Array.isArray(obj.ui)) {
    const uiOut: Record<string, { x: number; y: number }> = {};
    for (const [k, v] of Object.entries(obj.ui)) {
      if (!nodesById.has(k)) continue;
      if (!v || typeof v !== "object" || Array.isArray(v)) continue;
      const pos = v as Record<string, unknown>;
      if (typeof pos.x !== "number" || typeof pos.y !== "number") continue;
      if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue;
      uiOut[k] = { x: pos.x, y: pos.y };
    }
    if (Object.keys(uiOut).length > 0) ui = uiOut;
  }

  return {
    version: 1,
    nodes: validatedNodes,
    edges: validatedEdges,
    ...(ui ? { ui } : {}),
  };
}

/**
 * Pure DAG executor. Given an input payload and a validated graph, returns
 * the per-leaf deliveries that the router should enqueue.
 *
 * Determinism: deliveries appear in topological order; for a destination
 * with N parents, per-parent deliveries appear in incoming-edge order
 * (which is the same as the order they appear in `graph.edges`).
 *
 * Pruning semantics: a filter that returns false stops propagating its
 * value down its branch. Downstream nodes see no "carried" value from
 * that parent and produce no delivery via that path.
 */
export function executeGraph(
  payload: unknown,
  graph: PipelineGraph,
): { deliveries: LeafDelivery[] } {
  const { deliveries } = executeGraphInternal(payload, graph);
  return { deliveries };
}

/**
 * Same execution as `executeGraph`, but also returns a `carried` map of
 * `node_id → value` so callers can introspect what each node produced.
 * Used by the dashboard canvas to drive per-node UI state without
 * re-implementing the executor.
 *
 * Note: `carried.has(id)` distinguishes "this node propagated a value
 * downstream" from "this node was pruned" — the value itself may be
 * `undefined` if a transform legitimately produced it.
 */
export function executeGraphWithTrace(
  payload: unknown,
  graph: PipelineGraph,
): { deliveries: LeafDelivery[]; carried: Map<string, unknown> } {
  return executeGraphInternal(payload, graph);
}

function executeGraphInternal(
  payload: unknown,
  graph: PipelineGraph,
): { deliveries: LeafDelivery[]; carried: Map<string, unknown> } {
  const nodesById = new Map<string, PipelineNode>();
  for (const n of graph.nodes) nodesById.set(n.id, n);

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of nodesById.keys()) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const e of graph.edges) {
    outgoing.get(e.from)!.push(e.to);
    incoming.get(e.to)!.push(e.from);
  }

  // Kahn's algorithm — topological order.
  const inDegree = new Map<string, number>();
  for (const id of nodesById.keys()) {
    inDegree.set(id, incoming.get(id)!.length);
  }
  const queue: string[] = [];
  for (const [id, d] of inDegree.entries()) {
    if (d === 0) queue.push(id);
  }
  const topo: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topo.push(cur);
    for (const next of outgoing.get(cur)!) {
      const d = inDegree.get(next)! - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // carried.has(id) means "this node propagated a value downstream".
  // We use the existence of the key rather than `!== undefined` because
  // `undefined` is a valid payload value.
  const carried = new Map<string, unknown>();
  const deliveries: LeafDelivery[] = [];

  for (const nodeId of topo) {
    const node = nodesById.get(nodeId)!;
    switch (node.kind) {
      case "source":
        carried.set(node.id, payload);
        break;
      case "filter": {
        const parentId = incoming.get(node.id)![0]!;
        if (!carried.has(parentId)) break;
        const value = carried.get(parentId);
        if (runFilter(value, node.filter)) {
          carried.set(node.id, value);
        }
        break;
      }
      case "transform": {
        const parentId = incoming.get(node.id)![0]!;
        if (!carried.has(parentId)) break;
        const value = carried.get(parentId);
        carried.set(node.id, runTransform(value, node.transform));
        break;
      }
      case "destination": {
        // One delivery per non-pruned parent, in edge-insertion order.
        for (const parentId of incoming.get(node.id)!) {
          if (!carried.has(parentId)) continue;
          deliveries.push({
            destination_id: node.destination_id,
            leaf_node_id: node.id,
            payload: carried.get(parentId),
          });
        }
        // Record the destination as "reached" if any parent carried,
        // for canvas display purposes. Pick the first parent's value so
        // the inspector has something to show.
        for (const parentId of incoming.get(node.id)!) {
          if (carried.has(parentId)) {
            carried.set(node.id, carried.get(parentId));
            break;
          }
        }
        break;
      }
    }
  }

  return { deliveries, carried };
}
