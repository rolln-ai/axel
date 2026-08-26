import { describe, expect, it } from "vitest";
import { validatePipelineGraph, type PipelineGraph } from "@axel/shared";
import {
  addRepairToPipeline,
  parseInboxRepairSpec,
  repairProposalFromIssue,
  repairProposalsFromMessage,
  selectRepairProposalForDeliveryError,
  synthesizeLegacyPipeline,
} from "../lib/inbox-repair";

describe("inbox repair proposals", () => {
  it("turns an enriched decimal mismatch into an explicit rounded integer conversion", () => {
    const [proposal] = repairProposalsFromMessage(JSON.stringify({
      status: 200,
      schemaMismatches: [{
        path: "amount",
        kind: "type_conflict",
        expected: "FLOAT64",
        existing: "INT64",
        detail: "Axel sends FLOAT64 but the column is INT64.",
      }],
    }));
    expect(proposal).toMatchObject({
      title: "Fix amount data type",
      repair: { kind: "coerce", path: "amount", to: "integer", rounding: "round" },
    });
  });

  it("turns bool-to-STRING diagnostics into a text conversion", () => {
    const [proposal] = repairProposalsFromMessage(JSON.stringify({
      schemaMismatches: [{
        path: "active",
        kind: "type_conflict",
        expected: "BOOL",
        existing: "STRING",
        detail: "type drift",
      }],
    }));
    expect(proposal?.repair).toEqual({ kind: "coerce", path: "active", to: "string" });
  });

  it("parses the exact field from newer human-readable type diagnostics", () => {
    const [integer] = repairProposalsFromMessage(
      'BigQuery type mismatch at "data.properties.total_discounts": Axel sends STRING, but the target column is INT64. Retrying unchanged data will fail again. Change the target column type, or convert "data.properties.total_discounts" in the route before delivery.',
    );
    expect(integer).toMatchObject({
      issue: {
        path: "data.properties.total_discounts",
        expected: "STRING",
        existing: "INT64",
      },
      repair: {
        kind: "coerce",
        path: "data.properties.total_discounts",
        to: "integer",
        rounding: "round",
      },
    });

    const [text] = repairProposalsFromMessage(
      'BigQuery type mismatch at "data.properties.value": Axel sends INT64, but the target column is STRING. Retrying unchanged data will fail again. Change the target column to INT64, or convert "data.properties.value" to Text (STRING) before delivery.',
    );
    expect(text?.repair).toEqual({
      kind: "coerce",
      path: "data.properties.value",
      to: "string",
    });
  });

  it("parses a human-readable repeated-to-scalar diagnostic", () => {
    const [proposal] = repairProposalsFromMessage(
      'BigQuery type mismatch at "tags": Axel sends REPEATED STRING, but the target column is NULLABLE STRING. Retrying unchanged data will fail again. Use a compatible table where "tags" is REPEATED STRING, or add a Collapse arrays to text step for "tags" if one STRING value is intentional.',
    );
    expect(proposal?.repair).toEqual({
      kind: "collapse_array",
      path: "tags",
      format: "json",
    });
  });

  it("defers legacy leaf-only array errors to live schema diagnosis", () => {
    const proposals = repairProposalsFromMessage(
      '{"insertErrors":[{"message":"Array specified for non-repeated field: tags."}]}',
    );
    expect(proposals).toEqual([]);
  });

  it("matches a legacy array leaf to one live-diagnosed nested path", () => {
    const proposal = repairProposalFromIssue({
      path: "data.properties.tags",
      kind: "mode_conflict",
      expected: "REPEATED STRING",
      existing: "NULLABLE STRING",
      detail: "nested array",
    });
    expect(proposal).not.toBeNull();
    expect(selectRepairProposalForDeliveryError(
      "Array specified for non-repeated field: tags.",
      [proposal!],
    )?.repair).toEqual({
      kind: "collapse_array",
      path: "data.properties.tags",
      format: "json",
    });
  });

  it("refuses to guess when a legacy array leaf matches multiple nested paths", () => {
    const proposals = ["data.properties.tags", "data.customer.tags"].map((path) =>
      repairProposalFromIssue({
        path,
        kind: "mode_conflict",
        expected: "REPEATED STRING",
        existing: "NULLABLE STRING",
        detail: "nested array",
      })!,
    );
    expect(selectRepairProposalForDeliveryError(
      "Array specified for non-repeated field: tags.",
      proposals,
    )).toBeNull();
  });

  it("rejects integer conversion without an explicit rounding policy", () => {
    expect(parseInboxRepairSpec({ kind: "coerce", path: "amount", to: "integer" })).toBeNull();
  });
});

describe("destination-scoped pipeline repair", () => {
  const attached = new Set(["dst_a", "dst_b"]);
  const base: PipelineGraph = validatePipelineGraph({
    version: 1,
    nodes: [
      { id: "src", kind: "source" },
      { id: "a", kind: "destination", destination_id: "dst_a" },
      { id: "b", kind: "destination", destination_id: "dst_b" },
    ],
    edges: [
      { from: "src", to: "a" },
      { from: "src", to: "b" },
    ],
  }, { attached_destination_ids: attached });

  it("inserts the conversion only on the affected destination branch", () => {
    const result = addRepairToPipeline({
      graph: base,
      destinationId: "dst_a",
      repair: { kind: "coerce", path: "amount", to: "integer", rounding: "round" },
      nodeIdSeed: "test",
      attachedDestinationIds: attached,
    });
    expect(result.changed).toBe(true);
    expect(result.graph.edges).toContainEqual({ from: "src", to: "b" });
    expect(result.graph.edges).not.toContainEqual({ from: "src", to: "a" });
    const fix = result.graph.nodes.find((node) => node.kind === "transform");
    expect(fix).toMatchObject({
      kind: "transform",
      transform: {
        kind: "coerce",
        fields: [{ path: "amount", to: "integer", rounding: "round" }],
      },
    });
    expect(result.graph.edges).toContainEqual({ from: fix!.id, to: "a" });
  });

  it("merges a second scalar conversion into the private repair step", () => {
    const first = addRepairToPipeline({
      graph: base,
      destinationId: "dst_a",
      repair: { kind: "coerce", path: "amount", to: "integer", rounding: "round" },
      nodeIdSeed: "first",
      attachedDestinationIds: attached,
    });
    const second = addRepairToPipeline({
      graph: first.graph,
      destinationId: "dst_a",
      repair: { kind: "coerce", path: "active", to: "string" },
      nodeIdSeed: "second",
      attachedDestinationIds: attached,
    });
    const transforms = second.graph.nodes.filter((node) => node.kind === "transform");
    expect(transforms).toHaveLength(1);
    expect(transforms[0]).toMatchObject({
      transform: {
        kind: "coerce",
        fields: [
          { path: "amount", to: "integer", rounding: "round" },
          { path: "active", to: "string" },
        ],
      },
    });
  });

  it("converts a legacy route to an equivalent graph before adding the fix", () => {
    const graph = synthesizeLegacyPipeline({
      filterExpression: JSON.stringify({ kind: "always" }),
      transformScript: JSON.stringify({ kind: "passthrough" }),
      destinationIds: ["dst_a"],
    });
    expect(graph).toEqual({
      version: 1,
      nodes: [
        { id: "n_src", kind: "source" },
        { id: "n_dst_0", kind: "destination", destination_id: "dst_a" },
      ],
      edges: [{ from: "n_src", to: "n_dst_0" }],
    });
  });
});
