import type pg from "pg";
import { describe, expect, it } from "vitest";
import { validatePipelineGraph, type PipelineGraph } from "@axel/shared";
import {
  approvePatch,
  type ApprovalInput,
} from "../lib/data-contracts/explain";
import {
  resyncRouteToArtifacts,
  type DataContractVersionRow,
} from "../lib/data-contracts/repository";
import type { InferredDataContract } from "../lib/data-contracts/inference";
import type { SampledEvent } from "../lib/data-contracts/sampler";
import { shapeHash } from "../lib/data-contracts/sampler";

// ---------------------------------------------------------------------------
// A tiny fake pg.PoolClient that models exactly the queries the resync helper
// runs against the `routes` / `route_destinations` tables. We capture the
// final UPDATE so the test can assert the route now carries the PATCHED
// transform instead of the old one.
// ---------------------------------------------------------------------------

interface FakeRouteRow {
  id: string;
  pipeline_graph: string | null;
  filter_expression: string | null;
  transform_script: string | null;
}

interface FakeRoutesDb {
  route: FakeRouteRow | null;
  destinationIds: string[];
  /** Last values written by an UPDATE routes ... SET ... */
  updated: {
    pipeline_graph?: string | null;
    filter_expression?: string | null;
    transform_script?: string | null;
  } | null;
}

function fakeRouteClient(db: FakeRoutesDb): pg.PoolClient {
  return {
    async query(sql: string, params: unknown[] = []) {
      if (/FROM routes/.test(sql) && /FOR UPDATE/.test(sql)) {
        return { rows: db.route ? [db.route] : [], rowCount: db.route ? 1 : 0 };
      }
      if (/FROM route_destinations/.test(sql)) {
        return {
          rows: db.destinationIds.map((destination_id) => ({ destination_id })),
          rowCount: db.destinationIds.length,
        };
      }
      if (/UPDATE routes/.test(sql)) {
        // Legacy path: SET filter_expression = $3, transform_script = $4
        // Graph path: SET pipeline_graph = $3::jsonb, filter_expression = NULL, ...
        if (/pipeline_graph = \$3/.test(sql)) {
          db.updated = {
            pipeline_graph: params[2] as string,
            filter_expression: null,
            transform_script: null,
          };
        } else {
          db.updated = {
            pipeline_graph: db.route?.pipeline_graph ?? null,
            filter_expression: params[2] as string,
            transform_script: params[3] as string,
          };
        }
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as pg.PoolClient;
}

const ATTACHED = new Set(["dst_1"]);

/** Canonical codegen DAG graph: src -> transform(passthrough? no) -> dst. */
function canonicalGraph(transform: PipelineGraph["nodes"][number]): PipelineGraph {
  return {
    version: 1,
    nodes: [
      { id: "n_src", kind: "source" },
      transform,
      { id: "n_dst_dst_1", kind: "destination", destination_id: "dst_1" },
    ],
    edges: [
      { from: "n_src", to: "n_t_legacy" },
      { from: "n_t_legacy", to: "n_dst_dst_1" },
    ],
  };
}

describe("resyncRouteToArtifacts", () => {
  it("rewrites the transform node of a canonical pipeline_graph route", async () => {
    const oldGraph = canonicalGraph({
      id: "n_t_legacy",
      kind: "transform",
      transform: { kind: "select", assignments: { id: "id" } },
    });
    const db: FakeRoutesDb = {
      route: {
        id: "rt_1",
        pipeline_graph: JSON.stringify(oldGraph),
        filter_expression: null,
        transform_script: null,
      },
      destinationIds: ["dst_1"],
      updated: null,
    };

    const result = await resyncRouteToArtifacts(
      {
        routeId: "rt_1",
        workspaceId: "ws_1",
        filter: { kind: "always" },
        // The corrected transform the operator approved.
        transform: { kind: "select", assignments: { id: "data.id" } },
      },
      fakeRouteClient(db),
    );

    expect(result.outcome).toBe("updated_graph");
    expect(db.updated).not.toBeNull();
    expect(db.updated!.filter_expression).toBeNull();
    expect(db.updated!.transform_script).toBeNull();

    // The persisted graph must carry the PATCHED transform, not the old one.
    const written = validatePipelineGraph(JSON.parse(db.updated!.pipeline_graph!), {
      attached_destination_ids: ATTACHED,
    });
    const tNode = written.nodes.find((n) => n.kind === "transform");
    expect(tNode).toMatchObject({
      kind: "transform",
      transform: { kind: "select", assignments: { id: "data.id" } },
    });
    // Source + destination structure is preserved.
    expect(written.nodes.find((n) => n.kind === "source")?.id).toBe("n_src");
    expect(written.nodes.find((n) => n.kind === "destination")).toMatchObject({
      destination_id: "dst_1",
    });
  });

  it("rewrites filter_expression + transform_script for a legacy route", async () => {
    const db: FakeRoutesDb = {
      route: {
        id: "rt_legacy",
        pipeline_graph: null,
        filter_expression: JSON.stringify({ kind: "always" }),
        transform_script: JSON.stringify({ kind: "passthrough" }),
      },
      destinationIds: ["dst_1"],
      updated: null,
    };

    const result = await resyncRouteToArtifacts(
      {
        routeId: "rt_legacy",
        workspaceId: "ws_1",
        filter: { kind: "always" },
        transform: { kind: "envelope", event_type_path: "type", occurred_at_path: null },
      },
      fakeRouteClient(db),
    );

    expect(result.outcome).toBe("updated_legacy");
    expect(JSON.parse(db.updated!.transform_script!)).toEqual({
      kind: "envelope",
      event_type_path: "type",
      occurred_at_path: null,
    });
    expect(JSON.parse(db.updated!.filter_expression!)).toEqual({ kind: "always" });
  });

  it("skips a hand-edited graph (extra transform node) without clobbering it", async () => {
    const handEdited: PipelineGraph = {
      version: 1,
      nodes: [
        { id: "n_src", kind: "source" },
        { id: "n_t_legacy", kind: "transform", transform: { kind: "passthrough" } },
        // Operator added a second, bespoke transform — not codegen shape.
        { id: "n_t_custom", kind: "transform", transform: { kind: "jsonb_blob", column: "raw" } },
        { id: "n_dst_dst_1", kind: "destination", destination_id: "dst_1" },
      ],
      edges: [
        { from: "n_src", to: "n_t_legacy" },
        { from: "n_t_legacy", to: "n_t_custom" },
        { from: "n_t_custom", to: "n_dst_dst_1" },
      ],
    };
    const db: FakeRoutesDb = {
      route: {
        id: "rt_custom",
        pipeline_graph: JSON.stringify(handEdited),
        filter_expression: null,
        transform_script: null,
      },
      destinationIds: ["dst_1"],
      updated: null,
    };

    const result = await resyncRouteToArtifacts(
      {
        routeId: "rt_custom",
        workspaceId: "ws_1",
        filter: { kind: "always" },
        transform: { kind: "select", assignments: { id: "data.id" } },
      },
      fakeRouteClient(db),
    );

    expect(result.outcome).toBe("skipped_hand_edited");
    // No UPDATE was issued — the bespoke pipeline is untouched.
    expect(db.updated).toBeNull();
  });

  it("returns skipped_not_found when the route id is not in the workspace", async () => {
    const db: FakeRoutesDb = { route: null, destinationIds: [], updated: null };
    const result = await resyncRouteToArtifacts(
      {
        routeId: "rt_missing",
        workspaceId: "ws_1",
        filter: { kind: "always" },
        transform: { kind: "passthrough" },
      },
      fakeRouteClient(db),
    );
    expect(result.outcome).toBe("skipped_not_found");
    expect(db.updated).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// approvePatch must resync the live route(s) for the failed deliveries inside
// the same transaction, threading the PATCHED transform/filter through.
// ---------------------------------------------------------------------------

function inferred(over: Partial<InferredDataContract> = {}): InferredDataContract {
  return {
    event_types: [],
    fields: {},
    ids: [],
    timestamps: [],
    status_fields: [],
    sensitive_fields: [],
    summary: "",
    model_metadata: { model: null, prompt_version: "v", sample_count: 0, llm_enriched: false, ms: null },
    ...over,
  };
}

function ev(payload: unknown, id = "e1"): SampledEvent {
  return { event_id: id, received_at: "t", shard: 0, headers: {}, payload, shape_hash: shapeHash(payload) };
}

function baseInput(over: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    workspaceId: "ws_1",
    userId: "u1",
    dataContractId: "em_1",
    patch: {
      likely_cause: "",
      patch_kind: "transform",
      patched_transform: { kind: "select", assignments: { id: "data.id" } },
      confidence: 0.9,
      rationale: "",
    },
    currentVersion: {
      id: "emv_old",
      data_contract_id: "em_1",
      workspace_id: "ws_1",
      version_number: 1,
      inferred_schema: inferred({
        event_types: [
          { cluster_id: shapeHash({ id: "x" }), name: "x", example_event_ids: [], sample_count: 1 },
        ],
      }),
      field_annotations: {},
      generated_filter: null,
      generated_transform: null,
      transform_language: null,
      destination_mapping: null,
      model_metadata: {},
      fixture_results: null,
      created_by_user_id: null,
      created_at: "t",
    } as DataContractVersionRow,
    failedDeliveries: [
      { event_id: "e1", source_id: "src_1", route_id: "rt_1", r2_key: "k1" },
      // A second delivery on the SAME route — must dedupe to one resync.
      { event_id: "e2", source_id: "src_1", route_id: "rt_1", r2_key: "k2" },
    ],
    samples: [ev({ id: "x" }, "s1")],
    ...over,
  };
}

describe("approvePatch route resync", () => {
  it("resyncs each distinct failed-delivery route with the patched transform/filter", async () => {
    const resyncCalls: Array<{
      routeId: string;
      transform: unknown;
      filter: unknown;
    }> = [];

    const fakeTxClient = {
      async query(sql: string, params: unknown[] = []) {
        if (/WITH requested_replays AS/.test(sql)) {
          const eventIds = params[2] as string[];
          const sourceIds = params[3] as string[];
          const routeIds = params[4] as string[];
          const r2Keys = params[5] as string[];
          return {
            rows: eventIds.map((event_id, index) => ({
              event_id,
              source_id: sourceIds[index],
              route_id: routeIds[index],
              r2_key: r2Keys[index],
            })),
            rowCount: eventIds.length,
          };
        }
        if (/WITH candidates AS/.test(sql)) {
          // enqueueReplays candidate evaluation: echo the UNNEST arrays back
          // as candidate rows (nothing muted, nothing in flight).
          const [eventIds, sourceIds, r2Keys, routeIds] = params as [string[], string[], string[], string[]];
          const rows = eventIds.map((event_id, i) => ({
            event_id,
            source_id: sourceIds[i],
            r2_key: r2Keys[i],
            scope: "route",
            route_id: routeIds[i],
            destination_id: null,
            failure_reason: null,
            is_muted: false,
            is_in_flight: false,
          }));
          return { rows, rowCount: rows.length };
        }
        if (/INSERT INTO replay_requests/.test(sql)) {
          const ids = params[3] as string[];
          return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
        }
        return { rows: [], rowCount: 1 };
      },
    } as unknown as pg.PoolClient;

    const result = await approvePatch(baseInput(), {
      withTx: async (fn) => fn(fakeTxClient),
      versionAppender: async (input) => ({
        id: "emv_new",
        data_contract_id: input.dataContractId,
        workspace_id: input.workspaceId,
        version_number: 2,
        inferred_schema: input.inferredSchema,
        field_annotations: input.fieldAnnotations ?? {},
        generated_filter: input.generatedFilter ?? null,
        generated_transform: input.generatedTransform ?? null,
        transform_language: input.transformLanguage ?? null,
        destination_mapping: input.destinationMapping ?? null,
        model_metadata: input.modelMetadata ?? {},
        fixture_results: null,
        created_by_user_id: null,
        created_at: "t",
      }),
      fixtureInserter: async () => ({
        id: "fx",
        data_contract_version_id: "emv_new",
        workspace_id: "ws_1",
        source_event_id: null,
        event_type: null,
        input_payload: {},
        expected_output: {},
        created_at: "t",
      }),
      routeResyncer: async (input) => {
        resyncCalls.push({
          routeId: input.routeId,
          transform: input.transform,
          filter: input.filter,
        });
        return { route_id: input.routeId, outcome: "updated_graph" };
      },
    });

    // Two deliveries on rt_1 -> exactly one resync for rt_1.
    expect(resyncCalls).toHaveLength(1);
    expect(resyncCalls[0]!.routeId).toBe("rt_1");
    // The resync must carry the PATCHED transform, not the old (null) one.
    expect(resyncCalls[0]!.transform).toEqual({ kind: "select", assignments: { id: "data.id" } });
    expect(resyncCalls[0]!.filter).toEqual({ kind: "always" });
    // Still queues a replay per delivery and reports the resync outcomes.
    expect(result.replays_queued).toBe(2);
    expect(result.routes_resynced).toEqual([{ route_id: "rt_1", outcome: "updated_graph" }]);
  });
});
