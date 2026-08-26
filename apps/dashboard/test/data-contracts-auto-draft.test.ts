import { describe, expect, it } from "vitest";
import {
  autoDraftDataContract,
  runAutoDraftCronJob,
} from "../lib/data-contracts/auto-draft";
import type { InferredDataContract } from "../lib/data-contracts/inference";
import type {
  DataContractRow,
  DataContractVersionRow,
  SourceWithoutDataContractRow,
} from "../lib/data-contracts/repository";
import { shapeHash, type SampledEvent } from "../lib/data-contracts/sampler";

function source(over: Partial<SourceWithoutDataContractRow> = {}): SourceWithoutDataContractRow {
  return {
    source_id: "src_1",
    workspace_id: "ws_1",
    name: "newsletter-webhook",
    created_at: "2026-05-15T00:00:00.000Z",
    ...over,
  };
}

function sample(payload: unknown, eventId: string): SampledEvent {
  return {
    event_id: eventId,
    received_at: "t",
    shard: 0,
    headers: {},
    payload,
    shape_hash: shapeHash(payload),
  };
}

const FROZEN_NOW = () => new Date("2026-05-15T16:00:00.000Z");

describe("autoDraftDataContract", () => {
  it("creates a draft Data Contract + first version + emits a workspace-wide notification", async () => {
    const samples = [
      sample({ id: "1", amount: 100 }, "e1"),
      sample({ id: "2", amount: 200 }, "e2"),
      sample({ id: "3", amount: 300 }, "e3"),
    ];
    const notifyCalls: Array<{ workspaceId: string; kind: string; userId: string | null }> = [];
    let createdMap: DataContractRow | null = null;
    let appendedVersion: DataContractVersionRow | null = null;

    const outcome = await autoDraftDataContract(source(), {
      sampler: async () => samples,
      inferer: async (s, opts) => {
        // Confirm we're not paying the LLM on the batch path.
        expect(opts?.llmDisabled).toBe(true);
        return {
          event_types: [],
          fields: {},
          ids: [],
          timestamps: [],
          status_fields: [],
          sensitive_fields: [],
          summary: `${s.length} events`,
          model_metadata: {
            model: null,
            prompt_version: "test",
            sample_count: s.length,
            llm_enriched: false,
            ms: null,
          },
        };
      },
      creator: async (input) => {
        createdMap = {
          id: "em_auto_1",
          workspace_id: input.workspaceId,
          source_id: input.sourceId,
          route_id: null,
          name: input.name,
          status: "draft",
          current_version_id: null,
          created_by_user_id: null,
          created_at: "t",
          updated_at: "t",
        };
        return createdMap;
      },
      versionAppender: async (input) => {
        appendedVersion = {
          id: "emv_auto_1",
          data_contract_id: input.dataContractId,
          workspace_id: input.workspaceId,
          version_number: 1,
          inferred_schema: input.inferredSchema,
          field_annotations: {},
          generated_filter: null,
          generated_transform: null,
          transform_language: null,
          destination_mapping: null,
          model_metadata: input.modelMetadata ?? {},
          fixture_results: null,
          created_by_user_id: null,
          created_at: "t",
        };
        return appendedVersion;
      },
      notifier: async (input) => {
        notifyCalls.push({
          workspaceId: input.workspaceId,
          kind: input.kind,
          userId: input.userId ?? null,
        });
        return {
          id: "notif_1",
          workspace_id: input.workspaceId,
          user_id: input.userId ?? null,
          kind: input.kind,
          severity: input.severity ?? "info",
          title: input.title,
          body_md: input.bodyMd ?? null,
          link_path: input.linkPath ?? null,
          dedup_key: input.dedupKey ?? null,
          metadata: input.metadata ?? {},
          created_at: "t",
          read_at: null,
          alerted_at: null,
        };
      },
      now: FROZEN_NOW,
    });

    expect(outcome).toEqual({
      kind: "drafted",
      data_contract_id: "em_auto_1",
      sample_count: 3,
    });
    expect(createdMap).not.toBeNull();
    expect(createdMap!.name).toMatch(/^newsletter-webhook /);
    expect(appendedVersion).not.toBeNull();
    const meta = appendedVersion!.model_metadata as Record<string, unknown>;
    expect(meta.auto).toBe(true);
    expect(notifyCalls).toEqual([
      { workspaceId: "ws_1", kind: "data_contract_auto_drafted", userId: null },
    ]);
  });

  it("skips when the source has no events at all (will retry next cron tick)", async () => {
    const outcome = await autoDraftDataContract(source(), {
      sampler: async () => [],
      inferer: async () => {
        throw new Error("should not call");
      },
      creator: async () => {
        throw new Error("should not call");
      },
      versionAppender: async () => {
        throw new Error("should not call");
      },
      notifier: async () => null,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "no_samples" });
  });

  it("skips when there are fewer than the minimum useful samples", async () => {
    const outcome = await autoDraftDataContract(source(), {
      sampler: async () => [sample({ id: "1" }, "e1"), sample({ id: "2" }, "e2")],
      inferer: async () => {
        throw new Error("should not call");
      },
      creator: async () => {
        throw new Error("should not call");
      },
      versionAppender: async () => {
        throw new Error("should not call");
      },
      notifier: async () => null,
    });
    expect(outcome).toEqual({ kind: "skipped", reason: "too_few_samples" });
  });

  it("returns errored without partial side-effects if create fails", async () => {
    let appended = false;
    const outcome = await autoDraftDataContract(source(), {
      sampler: async () => [
        sample({ id: "1" }, "e1"),
        sample({ id: "2" }, "e2"),
        sample({ id: "3" }, "e3"),
      ],
      inferer: async () => ({
        event_types: [],
        fields: {},
        ids: [],
        timestamps: [],
        status_fields: [],
        sensitive_fields: [],
        summary: "",
        model_metadata: {
          model: null,
          prompt_version: "test",
          sample_count: 3,
          llm_enriched: false,
          ms: null,
        },
      } as InferredDataContract),
      creator: async () => {
        throw new Error("duplicate key value violates unique constraint");
      },
      versionAppender: async () => {
        appended = true;
        return {} as DataContractVersionRow;
      },
      notifier: async () => null,
    });
    expect(outcome.kind).toBe("errored");
    expect(appended).toBe(false);
  });

  it("treats notification failure as soft — draft still counts as drafted", async () => {
    const outcome = await autoDraftDataContract(source(), {
      sampler: async () => [
        sample({ id: "1" }, "e1"),
        sample({ id: "2" }, "e2"),
        sample({ id: "3" }, "e3"),
      ],
      inferer: async () => ({
        event_types: [],
        fields: {},
        ids: [],
        timestamps: [],
        status_fields: [],
        sensitive_fields: [],
        summary: "",
        model_metadata: {
          model: null,
          prompt_version: "test",
          sample_count: 3,
          llm_enriched: false,
          ms: null,
        },
      } as InferredDataContract),
      creator: async (input) =>
        ({
          id: "em_x",
          workspace_id: input.workspaceId,
          source_id: input.sourceId,
          route_id: null,
          name: input.name,
          status: "draft",
          current_version_id: null,
          created_by_user_id: null,
          created_at: "t",
          updated_at: "t",
        }) as DataContractRow,
      versionAppender: async (input) =>
        ({
          id: "emv_x",
          data_contract_id: input.dataContractId,
          workspace_id: input.workspaceId,
          version_number: 1,
          inferred_schema: input.inferredSchema,
          field_annotations: {},
          generated_filter: null,
          generated_transform: null,
          transform_language: null,
          destination_mapping: null,
          model_metadata: {},
          fixture_results: null,
          created_by_user_id: null,
          created_at: "t",
        }) as DataContractVersionRow,
      notifier: async () => {
        throw new Error("resend down");
      },
      now: FROZEN_NOW,
    });
    expect(outcome.kind).toBe("drafted");
  });
});

describe("runAutoDraftCronJob", () => {
  it("aggregates outcomes across sources and isolates per-source failures", async () => {
    const sources = [
      source({ source_id: "src_a", workspace_id: "ws_1", name: "ok-source" }),
      source({ source_id: "src_b", workspace_id: "ws_1", name: "empty-source" }),
      source({ source_id: "src_c", workspace_id: "ws_2", name: "bad-source" }),
      source({ source_id: "src_d", workspace_id: "ws_2", name: "thin-source" }),
    ];

    const summary = await runAutoDraftCronJob({
      listSources: async () => sources,
      sampler: async (_ws, srcId) => {
        if (srcId === "src_a") {
          return [
            sample({ id: "1" }, "e1"),
            sample({ id: "2" }, "e2"),
            sample({ id: "3" }, "e3"),
          ];
        }
        if (srcId === "src_b") return [];
        if (srcId === "src_c") throw new Error("clickhouse broke");
        return [sample({ id: "1" }, "e1")]; // src_d — 1 sample, too few
      },
      inferer: async () =>
        ({
          event_types: [],
          fields: {},
          ids: [],
          timestamps: [],
          status_fields: [],
          sensitive_fields: [],
          summary: "",
          model_metadata: {
            model: null,
            prompt_version: "test",
            sample_count: 3,
            llm_enriched: false,
            ms: null,
          },
        }) as InferredDataContract,
      creator: async (input) =>
        ({
          id: `em_${input.sourceId}`,
          workspace_id: input.workspaceId,
          source_id: input.sourceId,
          route_id: null,
          name: input.name,
          status: "draft",
          current_version_id: null,
          created_by_user_id: null,
          created_at: "t",
          updated_at: "t",
        }) as DataContractRow,
      versionAppender: async (input) =>
        ({
          id: `emv_${input.dataContractId}`,
          data_contract_id: input.dataContractId,
          workspace_id: input.workspaceId,
          version_number: 1,
          inferred_schema: input.inferredSchema,
          field_annotations: {},
          generated_filter: null,
          generated_transform: null,
          transform_language: null,
          destination_mapping: null,
          model_metadata: {},
          fixture_results: null,
          created_by_user_id: null,
          created_at: "t",
        }) as DataContractVersionRow,
      notifier: async () => null,
      now: FROZEN_NOW,
    });

    expect(summary.total_candidates).toBe(4);
    expect(summary.scanned).toBe(4);
    expect(summary.drafted).toBe(1);
    expect(summary.skipped_no_samples).toBe(1);
    expect(summary.skipped_too_few).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({
      source_id: "src_c",
      workspace_id: "ws_2",
    });
  });

  it("honors maxSources cap so a backlog can't run unbounded", async () => {
    const sources = Array.from({ length: 10 }, (_, i) =>
      source({ source_id: `src_${i}` }),
    );
    let scans = 0;
    const summary = await runAutoDraftCronJob({
      listSources: async () => sources,
      sampler: async () => {
        scans += 1;
        return [];
      },
      maxSources: 3,
    });
    expect(scans).toBe(3);
    expect(summary.total_candidates).toBe(10);
    expect(summary.scanned).toBe(3);
  });
});
