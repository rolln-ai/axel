import { describe, expect, it } from "vitest";
import {
  autoExtendIfNeeded,
  detectDrift,
  publicDriftCronSummary,
  runDriftCronJob,
  runDriftForDataContract,
  type DetectedDrift,
} from "../lib/data-contracts/drift";
import type { InferredDataContract } from "../lib/data-contracts/inference";
import type {
  DataContractRow,
  DataContractVersionRow,
  InsertDriftInput,
} from "../lib/data-contracts/repository";
import { shapeHash, type SampledEvent } from "../lib/data-contracts/sampler";

function emptyInferred(over: Partial<InferredDataContract> = {}): InferredDataContract {
  return {
    event_types: [],
    fields: {},
    ids: [],
    timestamps: [],
    status_fields: [],
    sensitive_fields: [],
    summary: "",
    model_metadata: {
      model: null,
      prompt_version: "v",
      sample_count: 0,
      llm_enriched: false,
      ms: null,
    },
    ...over,
  };
}

function ev(payload: unknown, eventId = "evt_x"): SampledEvent {
  return {
    event_id: eventId,
    received_at: "t",
    shard: 0,
    headers: {},
    payload,
    shape_hash: shapeHash(payload),
  };
}

describe("detectDrift", () => {
  it("returns [] when there are no incoming samples", () => {
    expect(detectDrift(emptyInferred(), [])).toEqual([]);
  });

  it("flags a new event type with cluster + proposed name + sample_count", () => {
    // Saved schema knows shape A only.
    const knownPayload = { type: "a", id: "1" };
    const saved = emptyInferred({
      event_types: [
        {
          cluster_id: shapeHash(knownPayload),
          name: "a",
          example_event_ids: [],
          sample_count: 1,
        },
      ],
      fields: {
        type: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
      },
    });
    // Incoming includes a brand-new shape B (extra `amount` field).
    const drifts = detectDrift(saved, [ev({ type: "b", id: "2", amount: 100 }, "newshape")]);
    const newType = drifts.find((d) => d.category === "new_event_type");
    expect(newType).toBeDefined();
    expect(newType!.detail.proposed_name).toBe("b");
    expect(newType!.sample_event_id).toBe("newshape");
  });

  it("classifies as unknown_shape when a known event-type name appears with a new shape over the volume threshold", () => {
    const oldPayload = { type: "a", id: "1" };
    const oldHash = shapeHash(oldPayload);
    const saved = emptyInferred({
      event_types: [
        { cluster_id: oldHash, name: "a", example_event_ids: [], sample_count: 1 },
      ],
    });
    // 3 incoming events of the SAME shape but with extra fields → new hash,
    // recycled name `a`. With volume >= 3 → unknown_shape.
    const samples = [
      ev({ type: "a", id: "1", extra: "x" }, "e1"),
      ev({ type: "a", id: "2", extra: "y" }, "e2"),
      ev({ type: "a", id: "3", extra: "z" }, "e3"),
    ];
    const drifts = detectDrift(saved, samples);
    expect(drifts.some((d) => d.category === "unknown_shape")).toBe(true);
    expect(drifts.find((d) => d.category === "unknown_shape")!.detail.is_known_event_type_with_new_shape).toBe(true);
  });

  it("flags missing_field when a previously-required path disappears", () => {
    const saved = emptyInferred({
      fields: {
        id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
      },
    });
    // Incoming events lack `amount`.
    const drifts = detectDrift(saved, [ev({ id: "1" })]);
    const miss = drifts.find((d) => d.category === "missing_field" && d.field_path === "amount");
    expect(miss).toBeDefined();
    expect(miss!.detail.previously).toEqual({ types: ["number"], presence: 1 });
  });

  it("flags type_change when an existing path's primitive type set changes", () => {
    const saved = emptyInferred({
      fields: {
        amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
      },
    });
    const drifts = detectDrift(saved, [ev({ amount: "100" }, "e1")]);
    const t = drifts.find((d) => d.category === "type_change" && d.field_path === "amount");
    expect(t).toBeDefined();
    expect(t!.detail.previously).toEqual(["number"]);
    expect(t!.detail.now).toEqual(["string"]);
  });

  it("does not false-fire new_event_type for pre-2026-05-18 schemas whose cluster_id is the raw shape hash", () => {
    // Backward-compat regression: before 2026-05-18 cluster_id was the
    // raw shape hash; now it's `t:<type-name>` when a type field is
    // present. The first cron pass after deploy would otherwise flag
    // every known event type as `new_event_type`.
    const payload = { type: "payment_intent.succeeded", id: "1" };
    const oldStyleHash = shapeHash(payload);
    const saved = emptyInferred({
      event_types: [
        {
          cluster_id: oldStyleHash,
          name: "payment_intent.succeeded",
          example_event_ids: [],
          sample_count: 1,
        },
      ],
      fields: {
        type: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
      },
    });
    const drifts = detectDrift(saved, [ev(payload, "evt_1")]);
    expect(drifts.find((d) => d.category === "new_event_type")).toBeUndefined();
  });

  it("flags new_sensitive_field on a newly-observed sensitive path", () => {
    const saved = emptyInferred({
      fields: {
        id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
      },
      // saved schema had no sensitive fields.
      sensitive_fields: [],
    });
    const drifts = detectDrift(saved, [ev({ id: "1", customer: { email: "a@b.com" } }, "e1")]);
    const s = drifts.find(
      (d) => d.category === "new_sensitive_field" && d.field_path === "customer.email",
    );
    expect(s).toBeDefined();
  });

  it("does NOT double-flag a sensitive field that was already known", () => {
    const saved = emptyInferred({
      fields: {
        "customer.email": { types: ["string"], required: true, presence: 1, distinct_count: 1 },
      },
      sensitive_fields: [{ path: "customer.email", reason: "deterministic" }],
    });
    const drifts = detectDrift(saved, [ev({ customer: { email: "a@b.com" } })]);
    expect(drifts.find((d) => d.category === "new_sensitive_field")).toBeUndefined();
  });
});

describe("runDriftForDataContract", () => {
  function map(): DataContractRow {
    return {
      id: "em_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      route_id: null,
      name: "map",
      status: "active",
      current_version_id: "emv_1",
      created_by_user_id: null,
      created_at: "t",
      updated_at: "t",
    };
  }

  function version(schema: InferredDataContract): DataContractVersionRow {
    return {
      id: "emv_1",
      data_contract_id: "em_1",
      workspace_id: "ws_1",
      version_number: 1,
      inferred_schema: schema,
      field_annotations: {},
      generated_filter: null,
      generated_transform: null,
      transform_language: null,
      destination_mapping: null,
      model_metadata: {},
      fixture_results: null,
      created_by_user_id: null,
      created_at: "t",
    };
  }

  it("inserts drift events scoped to the workspace + map + version", async () => {
    // Saved schema already knows the incoming shape, so the only drift we
    // produce is the type_change on `amount`. Without this, a new_event_type
    // drift would also fire (saved schema has no event_types).
    const incomingPayload = { amount: "100" };
    const knownHash = shapeHash(incomingPayload);
    const inserts: Array<{ category: string; field_path: string | null }> = [];
    const result = await runDriftForDataContract(
      "ws_1",
      {
        map: map(),
        currentVersion: version(
          emptyInferred({
            event_types: [
              { cluster_id: knownHash, name: "x", example_event_ids: [], sample_count: 1 },
            ],
            fields: {
              amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
            },
          }),
        ),
      },
      {
        sampler: async () => [ev(incomingPayload)],
        inserter: async (input) => {
          inserts.push({ category: input.category, field_path: input.fieldPath ?? null });
          return {
            id: "1",
            data_contract_id: input.dataContractId,
            data_contract_version_id: input.dataContractVersionId,
            workspace_id: input.workspaceId,
            category: input.category,
            field_path: input.fieldPath ?? null,
            detail: {},
            sample_event_id: null,
            observed_at: "t",
            resolved_at: null,
            resolved_by_user_id: null,
          };
        },
        lister: async () => [],
      },
    );

    expect(result.inserted).toBe(1);
    expect(inserts[0]).toEqual({ category: "type_change", field_path: "amount" });
  });

  it("dedups against existing unresolved drift rows", async () => {
    const incomingPayload = { amount: "100" };
    const knownHash = shapeHash(incomingPayload);
    let insertCalls = 0;
    const result = await runDriftForDataContract(
      "ws_1",
      {
        map: map(),
        currentVersion: version(
          emptyInferred({
            event_types: [
              { cluster_id: knownHash, name: "x", example_event_ids: [], sample_count: 1 },
            ],
            fields: {
              amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
            },
          }),
        ),
      },
      {
        sampler: async () => [ev(incomingPayload)],
        inserter: async () => {
          insertCalls++;
          throw new Error("should not be called");
        },
        lister: async () => [
          {
            id: "1",
            data_contract_id: "em_1",
            data_contract_version_id: "emv_1",
            workspace_id: "ws_1",
            category: "type_change",
            field_path: "amount",
            detail: {},
            sample_event_id: null,
            observed_at: "t",
            resolved_at: null,
            resolved_by_user_id: null,
          },
        ],
      },
    );
    expect(insertCalls).toBe(0);
    expect(result.inserted).toBe(0);
  });

  it("returns zero work when there are no samples", async () => {
    const result = await runDriftForDataContract(
      "ws_1",
      { map: map(), currentVersion: version(emptyInferred()) },
      {
        sampler: async () => [],
        typeLister: async () => [],
        inserter: async () => {
          throw new Error("should not insert");
        },
        lister: async () => [],
      },
    );
    expect(result.inserted).toBe(0);
  });

  const driftRow = (input: InsertDriftInput) => ({
    id: "1",
    data_contract_id: input.dataContractId,
    data_contract_version_id: input.dataContractVersionId,
    workspace_id: input.workspaceId,
    category: input.category,
    field_path: input.fieldPath ?? null,
    detail: input.detail ?? {},
    sample_event_id: input.sampleEventId ?? null,
    observed_at: "t",
    resolved_at: null,
    resolved_by_user_id: null,
  });

  it("coverage check flags a long-tail type the payload sample never surfaced", async () => {
    // The proportional sample sees nothing new (empty here), but the CH
    // distinct-type lister reports two types the saved schema lacks — exactly
    // the long-tail case where rare types cannot win a proportional draw.
    const inserts: Array<{ category: string; detail: unknown }> = [];
    const result = await runDriftForDataContract(
      "ws_1",
      {
        map: map(),
        currentVersion: version(
          emptyInferred({
            event_types: [
              {
                cluster_id: "t:subscriber.opened_email",
                name: "subscriber.opened_email",
                example_event_ids: [],
                sample_count: 1,
              },
            ],
          }),
        ),
      },
      {
        sampler: async () => [],
        typeLister: async () => [
          "subscriber.opened_email",
          "subscriber.bounced",
          "subscriber.complained",
        ],
        inserter: async (input) => {
          inserts.push({ category: input.category, detail: input.detail });
          return driftRow(input);
        },
        lister: async () => [],
      },
    );
    expect(result.inserted).toBe(1);
    expect(inserts[0]!.category).toBe("new_event_type");
    expect((inserts[0]!.detail as { missing_event_types?: string[] }).missing_event_types).toEqual([
      "subscriber.bounced",
      "subscriber.complained",
    ]);
  });

  it("coverage check stays quiet when every stream type is already captured", async () => {
    let insertCalls = 0;
    const result = await runDriftForDataContract(
      "ws_1",
      {
        map: map(),
        currentVersion: version(
          emptyInferred({
            event_types: [
              { cluster_id: "t:a", name: "a", example_event_ids: [], sample_count: 1 },
              { cluster_id: "t:b", name: "b", example_event_ids: [], sample_count: 1 },
            ],
          }),
        ),
      },
      {
        sampler: async () => [],
        typeLister: async () => ["a", "b"],
        inserter: async () => {
          insertCalls++;
          throw new Error("should not insert");
        },
        lister: async () => [],
      },
    );
    expect(insertCalls).toBe(0);
    expect(result.inserted).toBe(0);
  });
});

describe("runDriftCronJob", () => {
  function map(over: Partial<DataContractRow> = {}): DataContractRow {
    return {
      id: "em_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      route_id: null,
      name: "map",
      status: "active",
      current_version_id: "emv_1",
      created_by_user_id: null,
      created_at: "t",
      updated_at: "t",
      ...over,
    };
  }

  function version(): DataContractVersionRow {
    return {
      id: "emv_1",
      data_contract_id: "em_1",
      workspace_id: "ws_1",
      version_number: 1,
      inferred_schema: {
        event_types: [],
        fields: {},
        ids: [],
        timestamps: [],
        status_fields: [],
        sensitive_fields: [],
        summary: "",
        model_metadata: {
          model: null,
          prompt_version: "v",
          sample_count: 0,
          llm_enriched: false,
          ms: null,
        },
      } as InferredDataContract,
      field_annotations: {},
      generated_filter: null,
      generated_transform: null,
      transform_language: null,
      destination_mapping: null,
      model_metadata: {},
      fixture_results: null,
      created_by_user_id: null,
      created_at: "t",
    };
  }

  it("aggregates counts across all active maps", async () => {
    const maps = [
      map({ id: "em_a", workspace_id: "ws_1" }),
      map({ id: "em_b", workspace_id: "ws_1" }),
      map({ id: "em_c", workspace_id: "ws_2" }),
    ];
    const driftByMap: Record<string, DetectedDrift[]> = {
      em_a: [
        { category: "type_change", field_path: "amount", sample_event_id: null, detail: {} },
      ],
      em_b: [], // no drift
      em_c: [
        { category: "new_event_type", field_path: null, sample_event_id: "e1", detail: {} },
        { category: "missing_field", field_path: "id", sample_event_id: null, detail: {} },
      ],
    };
    const notifyCalls: Array<{ ws: string; mapId: string; drifts: number }> = [];

    const summary = await runDriftCronJob({
      listMaps: async () => maps,
      versionGetter: async () => version(),
      runOne: async (_ws, input) => {
        const drifts = driftByMap[input.map.id] ?? [];
        return { inserted: drifts.length, drifts };
      },
      notify: async (ws, mapId, drifts) => {
        notifyCalls.push({ ws, mapId, drifts: drifts.length });
        return drifts.length;
      },
    });

    expect(summary.total_maps).toBe(3);
    expect(summary.scanned_maps).toBe(3);
    expect(summary.maps_with_drift).toBe(2);
    expect(summary.total_drift_inserted).toBe(3);
    expect(summary.total_notifications_emitted).toBe(3);
    expect(summary.errors).toEqual([]);
    // notify only called for maps with drift
    expect(notifyCalls.map((c) => c.mapId).sort()).toEqual(["em_a", "em_c"]);
  });

  it("isolates per-map errors so one bad map doesn't abort the rest", async () => {
    const maps = [
      map({ id: "em_ok", workspace_id: "ws_1" }),
      map({ id: "em_bad", workspace_id: "ws_1" }),
      map({ id: "em_also_ok", workspace_id: "ws_2" }),
    ];
    let okRuns = 0;
    const summary = await runDriftCronJob({
      listMaps: async () => maps,
      versionGetter: async () => version(),
      runOne: async (_, input) => {
        if (input.map.id === "em_bad") {
          throw new Error("clickhouse exploded");
        }
        okRuns += 1;
        return { inserted: 0, drifts: [] };
      },
      notify: async () => 0,
    });
    expect(okRuns).toBe(2);
    expect(summary.scanned_maps).toBe(3);
    expect(summary.errors).toEqual([{ code: "data_contract_scan_failed" }]);
    expect(JSON.stringify(summary)).not.toContain("clickhouse exploded");
    expect(JSON.stringify(summary)).not.toContain("em_bad");
    expect(JSON.stringify(summary)).not.toContain("ws_1");

    const responseSummary = publicDriftCronSummary(summary);
    expect(responseSummary.error_count).toBe(1);
    expect(responseSummary.error_counts.data_contract_scan_failed).toBe(1);
    expect(responseSummary).not.toHaveProperty("errors");
  });

  it("treats notify failures as warnings, not fatal — drift inserts still count", async () => {
    const maps = [map({ id: "em_a" })];
    const summary = await runDriftCronJob({
      listMaps: async () => maps,
      versionGetter: async () => version(),
      runOne: async () => ({
        inserted: 2,
        drifts: [
          { category: "type_change", field_path: "amount", sample_event_id: null, detail: {} },
          { category: "missing_field", field_path: "id", sample_event_id: null, detail: {} },
        ],
      }),
      notify: async () => {
        throw new Error("resend timed out");
      },
    });
    expect(summary.total_drift_inserted).toBe(2);
    expect(summary.maps_with_drift).toBe(1);
    expect(summary.total_notifications_emitted).toBe(0);
    expect(summary.errors).toEqual([{ code: "notification_failed" }]);
    expect(JSON.stringify(summary)).not.toContain("resend timed out");
  });

  it("skips maps without a current_version_id (defensive against stale rows)", async () => {
    let runs = 0;
    const summary = await runDriftCronJob({
      listMaps: async () => [
        map({ id: "em_orphan", current_version_id: null }),
      ],
      versionGetter: async () => {
        throw new Error("should not call");
      },
      runOne: async () => {
        runs += 1;
        return { inserted: 0, drifts: [] };
      },
      notify: async () => 0,
    });
    expect(runs).toBe(0);
    expect(summary.scanned_maps).toBe(1);
    expect(summary.total_drift_inserted).toBe(0);
  });

  it("honors maxMaps cap", async () => {
    const maps = Array.from({ length: 10 }, (_, i) =>
      map({ id: `em_${i}` }),
    );
    let runs = 0;
    const summary = await runDriftCronJob({
      listMaps: async () => maps,
      versionGetter: async () => version(),
      runOne: async () => {
        runs += 1;
        return { inserted: 0, drifts: [] };
      },
      notify: async () => 0,
      maxMaps: 3,
    });
    expect(runs).toBe(3);
    expect(summary.total_maps).toBe(10);
    expect(summary.scanned_maps).toBe(3);
  });
});

describe("autoExtendIfNeeded", () => {
  function map(): DataContractRow {
    return {
      id: "em_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      route_id: null,
      name: "Newsletter demo",
      status: "active",
      current_version_id: "emv_1",
      created_by_user_id: null,
      created_at: "t",
      updated_at: "t",
    };
  }

  function version(eventTypes: Array<{ cluster_id: string; name: string }>): DataContractVersionRow {
    return {
      id: "emv_1",
      data_contract_id: "em_1",
      workspace_id: "ws_1",
      version_number: 1,
      inferred_schema: {
        event_types: eventTypes.map((c) => ({
          ...c,
          example_event_ids: [],
          sample_count: 1,
        })),
        fields: {},
        ids: [],
        timestamps: [],
        status_fields: [],
        sensitive_fields: [],
        summary: "",
        model_metadata: {
          model: null,
          prompt_version: "v",
          sample_count: 0,
          llm_enriched: false,
          ms: null,
        },
      } as InferredDataContract,
      field_annotations: {},
      generated_filter: null,
      generated_transform: null,
      transform_language: null,
      destination_mapping: null,
      model_metadata: {},
      fixture_results: null,
      created_by_user_id: null,
      created_at: "t",
    };
  }

  it("is a no-op when drift contains no new_event_type entries", async () => {
    const result = await autoExtendIfNeeded(
      map(),
      version([]),
      [
        { category: "type_change", field_path: "amount", sample_event_id: null, detail: {} },
      ],
      {
        sampler: async () => {
          throw new Error("should not sample");
        },
      },
    );
    expect(result).toEqual({ extended: false, new_version_id: null, added_clusters: [] });
  });

  it("appends a new version and notifies when resample finds a cluster the current version lacks", async () => {
    const newPayload = { type: "invoice.refunded", id: "1", amount: 100 };
    const newSamples = [ev(newPayload, "evt_new")];
    // Inference clusters by extracted type-name when present, so the
    // cluster_id for this payload is `t:invoice.refunded`, not the raw
    // shape hash. See clusterIdFor in inference.ts.
    const expectedClusterId = "t:invoice.refunded";
    const appendedRef: { value: { dataContractId: string; schemaClusters: string[] } | null } = { value: null };
    const notifiedRef: { value: { kind: string; severity: string; map_id: string } | null } = { value: null };

    const result = await autoExtendIfNeeded(
      map(),
      version([{ cluster_id: "old_hash", name: "payment_intent.succeeded" }]),
      [
        {
          category: "new_event_type",
          field_path: null,
          sample_event_id: "evt_new",
          detail: { proposed_name: "invoice.refunded" },
        },
      ],
      {
        sampler: async () => newSamples,
        versionAppender: async (input) => {
          const schema = input.inferredSchema as InferredDataContract;
          appendedRef.value = {
            dataContractId: input.dataContractId,
            schemaClusters: schema.event_types.map((c) => c.cluster_id),
          };
          return {
            id: "emv_2",
            data_contract_id: input.dataContractId,
            workspace_id: input.workspaceId,
            version_number: 2,
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
        },
        notifier: async (input) => {
          notifiedRef.value = {
            kind: input.kind,
            severity: input.severity ?? "info",
            map_id: (input.metadata as { data_contract_id: string }).data_contract_id,
          };
          return null;
        },
      },
    );

    expect(result.extended).toBe(true);
    expect(result.new_version_id).toBe("emv_2");
    expect(result.added_clusters).toEqual(["invoice.refunded"]);
    expect(appendedRef.value?.schemaClusters).toContain(expectedClusterId);
    expect(notifiedRef.value).toEqual({
      kind: "data_contract_auto_extended",
      severity: "info",
      map_id: "em_1",
    });
  });

  it("is idempotent — if a re-run produces no new clusters, no extension happens", async () => {
    const samePayload = { type: "payment_intent.succeeded", id: "1" };
    const sameHash = shapeHash(samePayload);
    let appends = 0;
    const result = await autoExtendIfNeeded(
      map(),
      version([{ cluster_id: sameHash, name: "payment_intent.succeeded" }]),
      [
        {
          category: "new_event_type",
          field_path: null,
          sample_event_id: "evt_x",
          detail: {},
        },
      ],
      {
        sampler: async () => [ev(samePayload, "evt_x")],
        versionAppender: async () => {
          appends += 1;
          throw new Error("should not append");
        },
      },
    );
    expect(result.extended).toBe(false);
    expect(appends).toBe(0);
  });
});
