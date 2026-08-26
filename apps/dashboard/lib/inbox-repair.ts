import {
  parseFilter,
  parseTransform,
  type BqCompatIssue,
  type GeneratedFilter,
  type GeneratedTransform,
  type IntegerRounding,
  type PipelineGraph,
  type PipelineNode,
  validatePipelineGraph,
  validateTransform,
} from "@axel/shared";

export type InboxRepairSpec =
  | {
      kind: "coerce";
      path: string;
      to: "string" | "integer" | "number" | "boolean";
      rounding?: IntegerRounding;
    }
  | {
      kind: "collapse_array";
      path: string;
      format: "json" | "join";
      separator?: string;
    };

type ScalarRepairTarget = Extract<InboxRepairSpec, { kind: "coerce" }>["to"];

export interface InboxRepairProposal {
  issue: BqCompatIssue;
  repair: InboxRepairSpec;
  title: string;
  summary: string;
}

const INTEGER_ROUNDING = new Set<IntegerRounding>([
  "round",
  "floor",
  "ceil",
  "truncate",
]);

/** Runtime validation for the repair submitted by the browser. */
export function parseInboxRepairSpec(value: unknown): InboxRepairSpec | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.kind === "coerce") {
    if (
      typeof raw.path !== "string" ||
      !["string", "integer", "number", "boolean"].includes(String(raw.to))
    ) {
      return null;
    }
    const to = raw.to as ScalarRepairTarget;
    const rounding = typeof raw.rounding === "string"
      ? raw.rounding as IntegerRounding
      : undefined;
    if (to === "integer" && (!rounding || !INTEGER_ROUNDING.has(rounding))) return null;
    if (to !== "integer" && rounding !== undefined) return null;
    const candidate: InboxRepairSpec = {
      kind: "coerce",
      path: raw.path,
      to,
      ...(rounding ? { rounding } : {}),
    };
    try {
      validateTransform(transformForRepair(candidate));
      return candidate;
    } catch {
      return null;
    }
  }
  if (raw.kind === "collapse_array") {
    if (
      typeof raw.path !== "string" ||
      (raw.format !== "json" && raw.format !== "join") ||
      (raw.separator !== undefined && typeof raw.separator !== "string")
    ) {
      return null;
    }
    const candidate: InboxRepairSpec = {
      kind: "collapse_array",
      path: raw.path,
      format: raw.format,
      ...(raw.format === "join" && typeof raw.separator === "string"
        ? { separator: raw.separator }
        : {}),
    };
    try {
      validateTransform(transformForRepair(candidate));
      return candidate;
    } catch {
      return null;
    }
  }
  return null;
}

function transformForRepair(repair: InboxRepairSpec): GeneratedTransform {
  return repair.kind === "coerce"
    ? {
        kind: "coerce",
        fields: [{
          path: repair.path,
          to: repair.to,
          ...(repair.rounding ? { rounding: repair.rounding } : {}),
        }],
      }
    : {
        kind: "collapse_arrays",
        fields: [{
          path: repair.path,
          format: repair.format,
          ...(repair.format === "join" && repair.separator !== undefined
            ? { separator: repair.separator }
            : {}),
        }],
      };
}

export function repairProposalFromIssue(issue: BqCompatIssue): InboxRepairProposal | null {
  const expected = issue.expected.toUpperCase();
  const existing = issue.existing.toUpperCase();

  if (
    issue.kind === "mode_conflict" &&
    expected.startsWith("REPEATED ") &&
    !existing.startsWith("REPEATED ")
  ) {
    return {
      issue,
      repair: { kind: "collapse_array", path: issue.path, format: "json" },
      title: `Store ${issue.path} as text`,
      summary: "Axel will preserve the full array as JSON text before sending it to this destination.",
    };
  }

  if (issue.kind !== "type_conflict") return null;
  const existingType = existing.replace(/^(NULLABLE|REQUIRED|REPEATED)\s+/, "");
  if (existingType === "STRING") {
    return {
      issue,
      repair: { kind: "coerce", path: issue.path, to: "string" },
      title: `Convert ${issue.path} to text`,
      summary: "Axel will convert this field to text before sending it to this destination.",
    };
  }
  if (existingType === "INT64" || existingType === "INTEGER") {
    return {
      issue,
      repair: { kind: "coerce", path: issue.path, to: "integer", rounding: "round" },
      title: `Convert ${issue.path} to an integer`,
      summary: "Choose how Axel should handle a fractional value before sending it to this destination.",
    };
  }
  if (["FLOAT64", "FLOAT", "NUMERIC", "BIGNUMERIC"].includes(existingType)) {
    return {
      issue,
      repair: { kind: "coerce", path: issue.path, to: "number" },
      title: `Convert ${issue.path} to a number`,
      summary: "Axel will convert this field to a number before sending it to this destination.",
    };
  }
  if (existingType === "BOOL" || existingType === "BOOLEAN") {
    return {
      issue,
      repair: { kind: "coerce", path: issue.path, to: "boolean" },
      title: `Convert ${issue.path} to true/false`,
      summary: "Axel will convert this field to a boolean before sending it to this destination.",
    };
  }
  return null;
}

/** Extract the delivery service's enriched BigQuery diagnostics. */
export function repairProposalsFromMessage(message: string): InboxRepairProposal[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message);
  } catch {
    parsed = null;
  }
  const root = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
  const candidates = Array.isArray(root?.schemaMismatches)
    ? root.schemaMismatches
    : root?.response && typeof root.response === "object" && !Array.isArray(root.response) &&
        Array.isArray((root.response as Record<string, unknown>).schemaMismatches)
      ? (root.response as Record<string, unknown>).schemaMismatches as unknown[]
      : [];
  const proposals: InboxRepairProposal[] = [];
  for (const candidate of candidates) {
    const issue = parseCompatIssue(candidate);
    if (!issue) continue;
    const proposal = repairProposalFromIssue(issue);
    if (proposal) proposals.push(proposal);
  }

  // The dead-letter writers prefer response.error when the connector supplies
  // one, so newer BigQuery failures are stored as this human-readable sentence
  // rather than the surrounding JSON response. Keep this parser in lockstep
  // with delivery-service actionableMismatchMessage(): it carries the exact
  // path and types and is safer than re-diagnosing a payload that may contain
  // several unrelated schema conflicts.
  if (proposals.length === 0) {
    const actionable = compatIssueFromActionableMessage(message);
    if (actionable) {
      const proposal = repairProposalFromIssue(actionable);
      if (proposal) proposals.push(proposal);
    }
  }

  return proposals;
}

/**
 * Match an exact or live-diagnosed proposal to the connector's terminal error.
 * Legacy BigQuery array errors only name the leaf (for example `tags`), while
 * the real field can be nested (`data.properties.tags`). Accept a leaf match
 * only when it identifies one proposal; guessing between two nested fields
 * would make the supposedly safe one-click repair mutate the wrong path.
 */
export function selectRepairProposalForDeliveryError(
  message: string,
  proposals: InboxRepairProposal[],
): InboxRepairProposal | null {
  if (/Cannot convert value to integer/i.test(message)) {
    return proposals.find(
      (proposal) => proposal.repair.kind === "coerce" && proposal.repair.to === "integer",
    ) ?? null;
  }
  if (/Conversion from bool to (?:std::)?string/i.test(message)) {
    return proposals.find(
      (proposal) => proposal.repair.kind === "coerce" && proposal.repair.to === "string",
    ) ?? null;
  }
  const array = /Array specified for non-repeated field:?\s*([A-Za-z0-9_\-.[\]]+)/i.exec(message);
  if (array) {
    const path = array[1]?.replace(/[.,;:]+$/, "");
    const matches = proposals.filter(
      (proposal) => proposal.repair.kind === "collapse_array" &&
        (!path || proposal.repair.path === path || proposal.repair.path.endsWith(`.${path}`)),
    );
    return matches.length === 1 ? matches[0]! : null;
  }
  return proposals.length === 1 ? proposals[0]! : null;
}

function compatIssueFromActionableMessage(message: string): BqCompatIssue | null {
  const match = /BigQuery type mismatch at "([^"]+)": Axel sends (.+?), but the target column is (.+?)\. Retrying unchanged data will fail again\./i.exec(
    message,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const path = match[1];
  const expected = match[2].trim().toUpperCase();
  const existing = match[3].trim().toUpperCase();
  const expectedRepeated = expected.startsWith("REPEATED ");
  const existingRepeated = existing.startsWith("REPEATED ");
  const expectedRecord = /(?:^|\s)(?:RECORD|STRUCT)$/.test(expected);
  const existingRecord = /(?:^|\s)(?:RECORD|STRUCT)$/.test(existing);
  const kind: BqCompatIssue["kind"] = expectedRepeated !== existingRepeated
    ? "mode_conflict"
    : expectedRecord !== existingRecord
      ? "record_scalar_conflict"
      : "type_conflict";
  return {
    path,
    kind,
    expected,
    existing,
    detail: `Axel sends ${expected}, but the target column is ${existing}.`,
  };
}

function parseCompatIssue(value: unknown): BqCompatIssue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.path !== "string" ||
    !["type_conflict", "mode_conflict", "record_scalar_conflict", "missing_required"].includes(String(raw.kind)) ||
    typeof raw.expected !== "string" ||
    typeof raw.existing !== "string"
  ) {
    return null;
  }
  return {
    path: raw.path,
    kind: raw.kind as BqCompatIssue["kind"],
    expected: raw.expected,
    existing: raw.existing,
    detail: typeof raw.detail === "string" ? raw.detail : "The incoming value does not fit this column.",
  };
}

export function synthesizeLegacyPipeline(input: {
  filterExpression: string | null;
  transformScript: string | null;
  destinationIds: string[];
}): PipelineGraph {
  const nodes: PipelineNode[] = [{ id: "n_src", kind: "source" }];
  const edges: PipelineGraph["edges"] = [];
  let cursor = "n_src";
  let filter: GeneratedFilter | null = null;
  let transform: GeneratedTransform | null = null;
  if (input.filterExpression) filter = parseFilter(input.filterExpression);
  if (input.transformScript) transform = parseTransform(input.transformScript);
  if (filter && filter.kind !== "always") {
    nodes.push({ id: "n_f_legacy", kind: "filter", filter });
    edges.push({ from: cursor, to: "n_f_legacy" });
    cursor = "n_f_legacy";
  }
  if (transform && transform.kind !== "passthrough") {
    nodes.push({ id: "n_t_legacy", kind: "transform", transform });
    edges.push({ from: cursor, to: "n_t_legacy" });
    cursor = "n_t_legacy";
  }
  input.destinationIds.forEach((destinationId, index) => {
    const id = `n_dst_${index}`;
    nodes.push({ id, kind: "destination", destination_id: destinationId });
    edges.push({ from: cursor, to: id });
  });
  return { version: 1, nodes, edges };
}

/** Add/merge a destination-only repair immediately before every matching leaf. */
export function addRepairToPipeline(input: {
  graph: PipelineGraph;
  destinationId: string;
  repair: InboxRepairSpec;
  nodeIdSeed: string;
  attachedDestinationIds: Set<string>;
}): { graph: PipelineGraph; changed: boolean } {
  const graph: PipelineGraph = {
    version: 1,
    nodes: input.graph.nodes.map((node) => ({ ...node })),
    edges: input.graph.edges.map((edge) => ({ ...edge })),
    ...(input.graph.ui ? { ui: { ...input.graph.ui } } : {}),
  };
  const destinationNodes = graph.nodes.filter(
    (node): node is Extract<PipelineNode, { kind: "destination" }> =>
      node.kind === "destination" && node.destination_id === input.destinationId,
  );
  if (destinationNodes.length === 0) throw new Error("repair_destination_not_in_pipeline");

  const wanted = transformForRepair(input.repair);
  let changed = false;
  let serial = 0;
  for (const destination of destinationNodes) {
    const incoming = graph.edges.filter((edge) => edge.to === destination.id);
    for (const edge of incoming) {
      const upstream = graph.nodes.find((node) => node.id === edge.from);
      const upstreamOutgoing = graph.edges.filter((candidate) => candidate.from === edge.from);
      if (
        upstream?.kind === "transform" &&
        upstreamOutgoing.length === 1 &&
        upstreamOutgoing[0]!.to === destination.id &&
        canMergeTransform(upstream.transform, wanted)
      ) {
        const merged = mergeTransform(upstream.transform, wanted);
        if (JSON.stringify(merged) !== JSON.stringify(upstream.transform)) {
          upstream.transform = merged;
          changed = true;
        }
        continue;
      }

      let nodeId: string;
      do {
        nodeId = `n_fix_${input.nodeIdSeed.slice(0, 36)}_${serial++}`;
      } while (graph.nodes.some((node) => node.id === nodeId));
      graph.nodes.push({ id: nodeId, kind: "transform", transform: wanted });
      const edgeIndex = graph.edges.indexOf(edge);
      graph.edges.splice(
        edgeIndex,
        1,
        { from: edge.from, to: nodeId },
        { from: nodeId, to: destination.id },
      );
      if (graph.ui?.[edge.from] && graph.ui[destination.id]) {
        graph.ui[nodeId] = {
          x: (graph.ui[edge.from]!.x + graph.ui[destination.id]!.x) / 2,
          y: (graph.ui[edge.from]!.y + graph.ui[destination.id]!.y) / 2,
        };
      }
      changed = true;
    }
  }
  return {
    graph: validatePipelineGraph(graph, {
      attached_destination_ids: input.attachedDestinationIds,
    }),
    changed,
  };
}

function canMergeTransform(current: GeneratedTransform, wanted: GeneratedTransform): boolean {
  return (
    (current.kind === "coerce" && wanted.kind === "coerce") ||
    (current.kind === "collapse_arrays" && wanted.kind === "collapse_arrays")
  );
}

function mergeTransform(current: GeneratedTransform, wanted: GeneratedTransform): GeneratedTransform {
  if (current.kind === "coerce" && wanted.kind === "coerce") {
    const field = wanted.fields[0]!;
    return {
      kind: "coerce",
      fields: [...current.fields.filter((existing) => existing.path !== field.path), field],
    };
  }
  if (current.kind === "collapse_arrays" && wanted.kind === "collapse_arrays") {
    const field = wanted.fields[0]!;
    return {
      kind: "collapse_arrays",
      fields: [...current.fields.filter((existing) => existing.path !== field.path), field],
    };
  }
  return wanted;
}
