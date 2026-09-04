import { describe, expect, it } from "vitest";
import {
  approvePatchImpl,
  deleteDataContractImpl,
  saveAnnotationsImpl,
  setDataContractStatusImpl,
  understandSourceImpl,
  type ActionSession,
} from "../lib/data-contracts/actions";
import {
  FixturesFailedError,
  InvalidApprovalReplayTargetsError,
  type ApprovalInput,
  type ApprovalResult,
} from "../lib/data-contracts/explain";
import type {
  AppendVersionInput,
  DataContractRow,
  DataContractVersionRow,
} from "../lib/data-contracts/repository";
import type { SampledEvent } from "../lib/data-contracts/sampler";

function ownerSession(over: Partial<ActionSession> = {}): ActionSession {
  return {
    user: { id: "usr_owner", ...(over.user ?? {}) },
    activeWorkspace: {
      workspace_id: "ws_1",
      role: "owner",
      ...(over.activeWorkspace ?? {}),
    },
  };
}

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.append(k, v);
  return f;
}

describe("understandSourceImpl", () => {
  it("rejects members without admin/owner role", async () => {
    const result = await understandSourceImpl(
      { user: { id: "u1" }, activeWorkspace: { workspace_id: "ws_1", role: "member" } },
      fd({ source_id: "src_1" }),
    );
    expect(result.error).toMatch(/only owners and admins/i);
  });

  it("requires source_id", async () => {
    const result = await understandSourceImpl(
      ownerSession(),
      fd({}),
    );
    expect(result.error).toMatch(/missing source/i);
  });

  it("returns a helpful error when no events are available to sample", async () => {
    const result = await understandSourceImpl(
      ownerSession(),
      fd({ source_id: "src_1" }),
      {
        sampler: async () => [],
        inferer: async () => {
          throw new Error("should not call");
        },
      },
    );
    expect(result.error).toMatch(/no events available/i);
  });

  it("does not expose sampler exceptions", async () => {
    const marker = "s3://marker-secret@private-payload-store/internal-key";
    const result = await understandSourceImpl(
      ownerSession(),
      fd({ source_id: "src_1" }),
      {
        sampler: async () => {
          throw new Error(marker);
        },
      },
    );

    expect(result.error).toBe(
      "Couldn't sample events. Check the source storage connection and try again.",
    );
    expect(result.error).not.toContain(marker);
  });

  it("does not expose inference exceptions", async () => {
    const marker = "provider response included marker-secret";
    const result = await understandSourceImpl(
      ownerSession(),
      fd({ source_id: "src_1" }),
      {
        sampler: async () => [
          {
            event_id: "e1",
            received_at: "t",
            shard: 0,
            headers: {},
            payload: { id: "1" },
            shape_hash: "h1",
          },
        ],
        inferer: async () => {
          throw new Error(marker);
        },
      },
    );

    expect(result.error).toBe(
      "Could not infer a Data Contract from the sampled events. Try again.",
    );
    expect(result.error).not.toContain(marker);
  });

  it("creates an data contract + first version from inferred output", async () => {
    const createdMaps: Array<{ workspaceId: string; sourceId: string; name: string }> = [];
    const appendedFor: string[] = [];
    const samplerCalls: Array<{ ws: string; src: string }> = [];

    const result = await understandSourceImpl(
      ownerSession(),
      fd({ source_id: "src_1", source_name: "Stripe webhooks" }),
      {
        sampler: async (ws, src) => {
          samplerCalls.push({ ws, src });
          return [
            { event_id: "e1", received_at: "t", shard: 0, headers: {}, payload: { id: "1" }, shape_hash: "h1" },
          ] satisfies SampledEvent[];
        },
        inferer: async () => ({
          event_types: [],
          fields: {},
          ids: [],
          timestamps: [],
          status_fields: [],
          sensitive_fields: [],
          summary: "stripe-ish",
          model_metadata: { model: null, prompt_version: "test", sample_count: 1, llm_enriched: false, ms: null },
        }),
        creator: async (input) => {
          createdMaps.push({ workspaceId: input.workspaceId, sourceId: input.sourceId, name: input.name });
          return {
            id: "em_1",
            workspace_id: input.workspaceId,
            source_id: input.sourceId,
            route_id: null,
            name: input.name,
            status: "draft",
            current_version_id: null,
            created_by_user_id: input.createdByUserId ?? null,
            created_at: "t",
            updated_at: "t",
          } satisfies DataContractRow;
        },
        versionAppender: async (input) => {
          appendedFor.push(input.dataContractId);
          return {
            id: "emv_1",
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
            created_by_user_id: input.createdByUserId ?? null,
            created_at: "t",
          } satisfies DataContractVersionRow;
        },
      },
    );

    expect(samplerCalls).toEqual([{ ws: "ws_1", src: "src_1" }]);
    expect(result.error).toBeUndefined();
    expect(result.data?.dataContractId).toBe("em_1");
    expect(result.data?.versionId).toBe("emv_1");
    expect(createdMaps[0]!.name).toMatch(/^Stripe webhooks /);
    expect(appendedFor).toEqual(["em_1"]);
  });

  it("maps unique-name 23505 error to a user-friendly message", async () => {
    const result = await understandSourceImpl(
      ownerSession(),
      fd({ source_id: "src_1" }),
      {
        sampler: async () => [
          { event_id: "e1", received_at: "t", shard: 0, headers: {}, payload: { id: "1" }, shape_hash: "h1" },
        ] satisfies SampledEvent[],
        inferer: async () => ({
          event_types: [],
          fields: {},
          ids: [],
          timestamps: [],
          status_fields: [],
          sensitive_fields: [],
          summary: "",
          model_metadata: { model: null, prompt_version: "v", sample_count: 1, llm_enriched: false, ms: null },
        }),
        creator: async () => {
          throw Object.assign(new Error("duplicate key"), {
            code: "23505",
            constraint: "data_contracts_workspace_lower_name_idx",
          });
        },
        versionAppender: async () => {
          throw new Error("should not be called");
        },
      },
    );
    expect(result.error).toMatch(/already exists/i);
  });

  it("does not expose persistence exceptions", async () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/schema";
    const result = await understandSourceImpl(
      ownerSession(),
      fd({ source_id: "src_1" }),
      {
        sampler: async () => [
          {
            event_id: "e1",
            received_at: "t",
            shard: 0,
            headers: {},
            payload: { id: "1" },
            shape_hash: "h1",
          },
        ] satisfies SampledEvent[],
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
            sample_count: 1,
            llm_enriched: false,
            ms: null,
          },
        }),
        creator: async () => {
          throw new Error(marker);
        },
      },
    );

    expect(result.error).toBe("Could not create the Data Contract. Try again.");
    expect(result.error).not.toContain(marker);
    expect(result.error).not.toContain("private-db.internal");
  });
});

describe("saveAnnotationsImpl", () => {
  it("applies cluster renames + merges annotations, appends a new version", async () => {
    interface BaseSchema {
      event_types: Array<{ cluster_id: string; name: string }>;
      fields: Record<string, unknown>;
    }
    const baseSchema: BaseSchema = {
      event_types: [
        { cluster_id: "h1", name: "Event 1" },
        { cluster_id: "h2", name: "Event 2" },
      ],
      fields: { id: { types: ["string"], required: true, presence: 1, distinct_count: 1 } },
    };
    let captured: AppendVersionInput | null = null;
    const result = await saveAnnotationsImpl(
      ownerSession(),
      "em_1",
      {
        cluster_renames: { h1: "Invoice paid", h2: "" },
        field_annotations: {
          "customer.email": { sensitive_override: true },
          "metadata.note": { ignored: true },
          // No-op annotation gets stripped.
          "unrelated.field": {},
        },
      },
      {
        mapGetter: async () => ({
          id: "em_1",
          workspace_id: "ws_1",
          source_id: "src_1",
          route_id: null,
          name: "x",
          status: "draft",
          current_version_id: "emv_1",
          created_by_user_id: null,
          created_at: "t",
          updated_at: "t",
        } as DataContractRow),
        versionGetter: async () => ({
          id: "emv_1",
          data_contract_id: "em_1",
          workspace_id: "ws_1",
          version_number: 1,
          inferred_schema: baseSchema,
          field_annotations: { existing: { ignored: true } },
          generated_filter: "f",
          generated_transform: "t",
          transform_language: "jsonata",
          destination_mapping: { kind: "postgres" },
          model_metadata: { sample_count: 1 },
          fixture_results: null,
          created_by_user_id: null,
          created_at: "t",
        } as DataContractVersionRow),
        versionAppender: async (input) => {
          captured = input;
          return {
            id: "emv_2",
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
          } satisfies DataContractVersionRow;
        },
      },
    );

    expect(result.error).toBeUndefined();
    expect(captured).not.toBeNull();
    const cap = captured!;
    const renamedSchema = cap.inferredSchema as BaseSchema;
    expect(renamedSchema.event_types[0]!.name).toBe("Invoice paid");
    // Empty rename is ignored.
    expect(renamedSchema.event_types[1]!.name).toBe("Event 2");
    const ann = cap.fieldAnnotations as Record<string, unknown>;
    expect(ann.existing).toEqual({ ignored: true }); // preserved
    expect(ann["customer.email"]).toEqual({ sensitive_override: true });
    expect(ann["metadata.note"]).toEqual({ ignored: true });
    // No-op annotation was stripped.
    expect(ann["unrelated.field"]).toBeUndefined();
    // Generated artifacts and destination_mapping carried over unchanged.
    expect(cap.generatedFilter).toBe("f");
    expect(cap.generatedTransform).toBe("t");
    expect(cap.transformLanguage).toBe("jsonata");
  });

  it("errors out when the data contract has no current version", async () => {
    const result = await saveAnnotationsImpl(
      ownerSession(),
      "em_orphan",
      {},
      {
        mapGetter: async () => ({
          id: "em_orphan",
          workspace_id: "ws_1",
          source_id: "src_1",
          route_id: null,
          name: "x",
          status: "draft",
          current_version_id: null,
          created_by_user_id: null,
          created_at: "t",
          updated_at: "t",
        } as DataContractRow),
        versionGetter: async () => {
          throw new Error("should not call");
        },
        versionAppender: async () => {
          throw new Error("should not call");
        },
      },
    );
    expect(result.error).toMatch(/no version yet/i);
  });

  it("rejects members from saving", async () => {
    const result = await saveAnnotationsImpl(
      {
        user: { id: "u1" },
        activeWorkspace: { workspace_id: "ws_1", role: "member" },
      },
      "em_1",
      {},
    );
    expect(result.error).toMatch(/only owners and admins/i);
  });
});

describe("setDataContractStatusImpl", () => {
  it("rejects members", async () => {
    const result = await setDataContractStatusImpl(
      { user: { id: "u1" }, activeWorkspace: { workspace_id: "ws_1", role: "member" } },
      "em_1",
      "active",
    );
    expect(result.error).toMatch(/only owners and admins/i);
  });

  it("calls the status updater with workspace + id + status", async () => {
    let called: { id: string; ws: string; status: string } | null = null;
    const result = await setDataContractStatusImpl(
      ownerSession(),
      "em_1",
      "active",
      {
        statusUpdater: async (id, ws, status) => {
          called = { id, ws, status };
        },
      },
    );
    expect(called).toEqual({ id: "em_1", ws: "ws_1", status: "active" });
    expect(result.notice).toMatch(/active/i);
  });
});

describe("approvePatchImpl", () => {
  function baseInput(): Omit<ApprovalInput, "userId" | "workspaceId"> {
    return {
      dataContractId: "em_1",
      patch: {
        likely_cause: "",
        patch_kind: "transform",
        patched_transform: { kind: "passthrough" },
        confidence: 0.9,
        rationale: "",
      },
      currentVersion: {
        id: "emv_old",
        data_contract_id: "em_1",
        workspace_id: "ws_1",
        version_number: 1,
        inferred_schema: {},
        field_annotations: {},
        generated_filter: null,
        generated_transform: null,
        transform_language: null,
        destination_mapping: null,
        model_metadata: {},
        fixture_results: null,
        created_by_user_id: null,
        created_at: "t",
      },
      failedDeliveries: [
        { event_id: "e1", source_id: "src_1", route_id: "rt_1", r2_key: "k1" },
      ],
      samples: [],
    };
  }

  it("rejects members", async () => {
    const result = await approvePatchImpl(
      {
        user: { id: "u1" },
        activeWorkspace: { workspace_id: "ws_1", role: "member" },
      },
      baseInput(),
    );
    expect(result.error).toMatch(/only owners and admins/i);
  });

  it("threads workspace + user id into the approval call and returns the new version", async () => {
    let captured: ApprovalInput | null = null;
    const result = await approvePatchImpl(ownerSession(), baseInput(), {
      approvePatch: async (input) => {
        captured = input;
        const out: ApprovalResult = {
          new_version_id: "emv_new",
          fixture_result: {
            passed: 2,
            failed: 0,
            total: 2,
            failures: [],
            ran_at: "t",
          },
          replays_queued: 1,
        };
        return out;
      },
    });

    expect(captured).not.toBeNull();
    expect(captured!.workspaceId).toBe("ws_1");
    expect(captured!.userId).toBe("usr_owner");
    expect(captured!.dataContractId).toBe("em_1");
    expect(result.error).toBeUndefined();
    expect(result.data?.versionId).toBe("emv_new");
    expect(result.result?.replays_queued).toBe(1);
    expect(result.notice).toMatch(/Queued 1 replay/);
  });

  it("maps FixturesFailedError to a user-readable error with the gate counts", async () => {
    const result = await approvePatchImpl(ownerSession(), baseInput(), {
      approvePatch: async () => {
        throw new FixturesFailedError({
          passed: 2,
          failed: 1,
          total: 3,
          failures: [],
          ran_at: "t",
        });
      },
    });
    expect(result.error).toMatch(/1\/3 fixtures failed/);
    expect(result.fixture_failures).toEqual({ passed: 2, failed: 1, total: 3 });
  });

  it("maps an invalid replay target to a refresh-safe error", async () => {
    const result = await approvePatchImpl(ownerSession(), baseInput(), {
      approvePatch: async () => {
        throw new InvalidApprovalReplayTargetsError();
      },
    });

    expect(result.error).toMatch(/unavailable or do not belong/i);
    expect(result.error).toMatch(/refresh and try again/i);
    expect(result.error).not.toContain("k1");
  });

  it("does not expose generic approval error details", async () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/schema";
    const result = await approvePatchImpl(ownerSession(), baseInput(), {
      approvePatch: async () => {
        throw new Error(marker);
      },
    });
    expect(result.error).toBe("Approval failed. No changes were applied. Try again.");
    expect(result.error).not.toContain(marker);
    expect(result.error).not.toContain("private-db.internal");
  });
});

describe("deleteDataContractImpl", () => {
  it("rejects members", async () => {
    const result = await deleteDataContractImpl(
      {
        user: { id: "u1" },
        activeWorkspace: { workspace_id: "ws_1", role: "member" },
      },
      "em_1",
    );
    expect(result.error).toMatch(/only owners and admins/i);
  });

  it("returns not-found when no row was deleted (wrong workspace / already gone)", async () => {
    const result = await deleteDataContractImpl(ownerSession(), "em_missing", {
      deleter: async () => false,
    });
    expect(result.error).toMatch(/not found/i);
  });

  it("calls the deleter with id + workspace and surfaces the deleted id back", async () => {
    let called: { id: string; ws: string } | null = null;
    const result = await deleteDataContractImpl(ownerSession(), "em_1", {
      deleter: async (id, ws) => {
        called = { id, ws };
        return true;
      },
    });
    expect(called).toEqual({ id: "em_1", ws: "ws_1" });
    expect(result.error).toBeUndefined();
    expect(result.notice).toMatch(/deleted/i);
    expect(result.data?.dataContractId).toBe("em_1");
  });
});
