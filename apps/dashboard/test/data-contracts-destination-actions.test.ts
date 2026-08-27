import { describe, expect, it, vi } from "vitest";
import {
  saveDestinationMappingImpl,
} from "../lib/data-contracts/destination-actions";
import type { DestinationMapping } from "../lib/data-contracts/destination-mapping";
import type {
  DataContractRow,
  DataContractVersionRow,
} from "../lib/data-contracts/repository";

const session = {
  user: { id: "usr_1" },
  activeWorkspace: { workspace_id: "ws_1", role: "owner" as const },
};

const map: DataContractRow = {
  id: "em_1",
  workspace_id: "ws_1",
  source_id: "src_1",
  route_id: null,
  name: "Contract",
  status: "draft",
  current_version_id: "emv_1",
  created_by_user_id: "usr_1",
  created_at: "2026-08-27",
  updated_at: "2026-08-27",
};

const version: DataContractVersionRow = {
  id: "emv_1",
  data_contract_id: "em_1",
  workspace_id: "ws_1",
  version_number: 1,
  inferred_schema: { fields: {} },
  field_annotations: {},
  generated_filter: null,
  generated_transform: null,
  transform_language: null,
  destination_mapping: null,
  model_metadata: {},
  fixture_results: null,
  created_by_user_id: "usr_1",
  created_at: "2026-08-27",
};

const mapping: DestinationMapping = {
  kind: "webhook",
  destination_id: "dst_1",
  body_strategy: "passthrough",
  headers: {},
  rationale: "test",
  preview: [{ event_id: "evt_private", before: { secret: "x" }, after: { secret: "x" } }],
};

function baseDeps() {
  return {
    mapGetter: vi.fn(async () => map),
    versionGetter: vi.fn(async () => version),
    versionAppender: vi.fn(async () => ({ ...version, id: "emv_2", version_number: 2 })),
  };
}

describe("saveDestinationMappingImpl ownership", () => {
  it("rejects a destination outside the active workspace", async () => {
    const deps = baseDeps();
    const result = await saveDestinationMappingImpl(
      session,
      { dataContractId: "em_1", mapping },
      { ...deps, destinationFetcher: async () => null },
    );
    expect(result.error).toMatch(/not found in this workspace/i);
    expect(deps.versionAppender).not.toHaveBeenCalled();
  });

  it("rejects a mapping kind that does not match the owned destination", async () => {
    const deps = baseDeps();
    const result = await saveDestinationMappingImpl(
      session,
      { dataContractId: "em_1", mapping },
      {
        ...deps,
        destinationFetcher: async () => ({
          id: "dst_1",
          type: "postgres",
          config: {},
          name: "Database",
        }),
      },
    );
    expect(result.error).toMatch(/mapping type does not match/i);
    expect(deps.versionAppender).not.toHaveBeenCalled();
  });

  it("allows an owned HTTP destination for a webhook mapping", async () => {
    const deps = baseDeps();
    const result = await saveDestinationMappingImpl(
      session,
      { dataContractId: "em_1", mapping },
      {
        ...deps,
        destinationFetcher: async () => ({
          id: "dst_1",
          type: "http",
          config: {},
          name: "Webhook",
        }),
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.version_id).toBe("emv_2");
    expect(deps.versionAppender).toHaveBeenCalledOnce();
  });
});
