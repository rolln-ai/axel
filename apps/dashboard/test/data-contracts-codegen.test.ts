import { describe, expect, it } from "vitest";
import type { DestinationMapping } from "../lib/data-contracts/destination-mapping";
import type { InferredDataContract } from "../lib/data-contracts/inference";
import {
  buildFixturesFromSamples,
  canActivate,
  generateRouteArtifacts,
  runFilter,
  runFixtures,
  runTransform,
  withTransientStatusFields,
  type GeneratedFilter,
  type GeneratedTransform,
} from "../lib/data-contracts/codegen";
import type { SampledEvent } from "../lib/data-contracts/sampler";

function inferred(over: Partial<InferredDataContract> = {}): InferredDataContract {
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
      prompt_version: "v1",
      sample_count: 0,
      llm_enriched: false,
      ms: null,
    },
    ...over,
  };
}

function sample(payload: unknown, eventId: string, shape: string): SampledEvent {
  return {
    event_id: eventId,
    received_at: "t",
    shard: 0,
    headers: {},
    payload,
    shape_hash: shape,
  };
}

describe("generateRouteArtifacts", () => {
  it("postgres columns mode → select transform with column assignments", () => {
    const mapping: DestinationMapping = {
      kind: "postgres",
      destination_id: "d1",
      table: "t",
      mode: "columns",
      column_assignments: { id: "id", amount: "amount" },
      idempotency_column: "id",
      preview: [],
      rationale: "",
    };
    const { transform } = generateRouteArtifacts(inferred(), mapping);
    expect(transform).toEqual({
      kind: "select",
      assignments: { id: "id", amount: "amount" },
    });
  });

  it("postgres jsonb mode → jsonb_blob transform with chosen column", () => {
    const mapping: DestinationMapping = {
      kind: "postgres",
      destination_id: "d1",
      table: "t",
      mode: "jsonb",
      jsonb_column: "payload",
      idempotency_column: null,
      preview: [],
      rationale: "",
    };
    const { transform } = generateRouteArtifacts(inferred(), mapping);
    expect(transform).toEqual({ kind: "jsonb_blob", column: "payload" });
  });

  it("mongo with id + projected paths → select transform building doc shape", () => {
    const mapping: DestinationMapping = {
      kind: "mongodb",
      destination_id: "d1",
      collection: "c",
      id_path: "id",
      projected_paths: ["id", "amount"],
      preview: [],
      rationale: "",
    };
    const { transform } = generateRouteArtifacts(inferred(), mapping);
    expect(transform).toEqual({
      kind: "select",
      assignments: { _id: "id", id: "id", amount: "amount" },
    });
  });

  it("webhook passthrough → passthrough transform", () => {
    const mapping: DestinationMapping = {
      kind: "webhook",
      destination_id: "d1",
      body_strategy: "passthrough",
      headers: {},
      preview: [],
      rationale: "",
    };
    const { transform } = generateRouteArtifacts(inferred(), mapping);
    expect(transform).toEqual({ kind: "passthrough" });
  });

  it("BigQuery typed records → passthrough transform for connector shaping", () => {
    const mapping: DestinationMapping = {
      kind: "bigquery",
      destination_id: "d1",
      dataset: "analytics",
      table: "events",
      mode: "typed_records",
      preview: [],
      rationale: "",
    };
    const { transform } = generateRouteArtifacts(inferred(), mapping);
    expect(transform).toEqual({ kind: "passthrough" });
  });

  it("filter defaults to always when no selection is given", () => {
    const m: DestinationMapping = {
      kind: "webhook",
      destination_id: "d1",
      body_strategy: "passthrough",
      headers: {},
      preview: [],
      rationale: "",
    };
    const { filter } = generateRouteArtifacts(inferred(), m);
    expect(filter).toEqual({ kind: "always" });
  });

  it("filter restricts to selected event types when type field is detected", () => {
    const m: DestinationMapping = {
      kind: "webhook",
      destination_id: "d1",
      body_strategy: "passthrough",
      headers: {},
      preview: [],
      rationale: "",
    };
    const { filter } = generateRouteArtifacts(
      inferred({
        event_types: [
          { cluster_id: "h1", name: "invoice.paid", example_event_ids: [], sample_count: 1 },
          { cluster_id: "h2", name: "invoice.refunded", example_event_ids: [], sample_count: 1 },
        ],
        status_fields: [{ path: "type", values: ["invoice.paid", "invoice.refunded", "other"] }],
      }),
      m,
      { selected_event_type_names: ["invoice.paid"] },
    );
    expect(filter).toEqual({
      kind: "event_type_in",
      path: "type",
      values: ["invoice.paid"],
    });
  });

  it("falls back to always-on filter if selected names don't match observed values", () => {
    const m: DestinationMapping = {
      kind: "webhook",
      destination_id: "d1",
      body_strategy: "passthrough",
      headers: {},
      preview: [],
      rationale: "",
    };
    const { filter } = generateRouteArtifacts(
      inferred({
        event_types: [
          { cluster_id: "h1", name: "invoice.paid", example_event_ids: [], sample_count: 1 },
        ],
        status_fields: [{ path: "type", values: ["other"] }],
      }),
      m,
      { selected_event_type_names: ["invoice.paid"] },
    );
    expect(filter).toEqual({ kind: "always" });
  });

  it("rebuilds status values transiently when the durable schema has scrubbed them", () => {
    const durable = inferred({
      event_types: [
        { cluster_id: "h1", name: "invoice.paid", example_event_ids: [], sample_count: 1 },
      ],
      status_fields: [{ path: "type", values: [] }],
    });
    const transient = withTransientStatusFields(
      durable,
      [sample({ type: "invoice.paid", id: "evt_1" }, "e1", "h1")],
    );
    const mapping: DestinationMapping = {
      kind: "webhook",
      destination_id: "d1",
      body_strategy: "passthrough",
      headers: {},
      preview: [],
      rationale: "",
    };

    expect(durable.status_fields[0]!.values).toEqual([]);
    expect(transient.status_fields[0]!.values).toEqual(["invoice.paid"]);
    expect(
      generateRouteArtifacts(transient, mapping, {
        selected_event_type_names: ["invoice.paid"],
      }).filter,
    ).toEqual({
      kind: "event_type_in",
      path: "type",
      values: ["invoice.paid"],
    });
  });
});

describe("runTransform", () => {
  it("passthrough returns the payload unchanged", () => {
    expect(runTransform({ a: 1 }, { kind: "passthrough" })).toEqual({ a: 1 });
  });
  it("select with simple assignments", () => {
    const out = runTransform(
      { id: "evt", customer: { email: "a@b.com" } },
      { kind: "select", assignments: { event_id: "id", email: "customer.email" } },
    );
    expect(out).toEqual({ event_id: "evt", email: "a@b.com" });
  });
  it("envelope wraps payload with event_type + occurred_at", () => {
    const out = runTransform(
      { type: "user.created", created_at: "2026-05-15T00:00:00Z", id: 1 },
      {
        kind: "envelope",
        event_type_path: "type",
        occurred_at_path: "created_at",
      },
    );
    expect(out).toEqual({
      event_type: "user.created",
      occurred_at: "2026-05-15T00:00:00Z",
      data: { type: "user.created", created_at: "2026-05-15T00:00:00Z", id: 1 },
    });
  });
  it("jsonb_blob wraps payload in a single column", () => {
    expect(runTransform({ x: 1 }, { kind: "jsonb_blob", column: "payload" })).toEqual({
      payload: { x: 1 },
    });
  });
});

describe("runFilter", () => {
  it("always-on passes", () => {
    expect(runFilter({ anything: 1 }, { kind: "always" })).toBe(true);
  });
  it("event_type_in matches included value", () => {
    const f: GeneratedFilter = { kind: "event_type_in", path: "type", values: ["a", "b"] };
    expect(runFilter({ type: "a" }, f)).toBe(true);
    expect(runFilter({ type: "c" }, f)).toBe(false);
  });
  it("and is conjunctive", () => {
    const f: GeneratedFilter = {
      kind: "and",
      parts: [
        { kind: "event_type_in", path: "type", values: ["a"] },
        { kind: "event_type_in", path: "status", values: ["paid"] },
      ],
    };
    expect(runFilter({ type: "a", status: "paid" }, f)).toBe(true);
    expect(runFilter({ type: "a", status: "void" }, f)).toBe(false);
  });
});

describe("buildFixturesFromSamples + runFixtures", () => {
  it("emits one fixture per cluster and expected outputs round-trip exactly", () => {
    const samples = [
      sample({ type: "a", id: 1 }, "e1", "shape_a"),
      sample({ type: "a", id: 2 }, "e2", "shape_a"),
      sample({ type: "b", id: 3 }, "e3", "shape_b"),
    ];
    const inf = inferred({
      event_types: [
        { cluster_id: "shape_a", name: "alpha", example_event_ids: [], sample_count: 2 },
        { cluster_id: "shape_b", name: "beta", example_event_ids: [], sample_count: 1 },
      ],
    });
    const transform: GeneratedTransform = {
      kind: "envelope",
      event_type_path: "type",
      occurred_at_path: null,
    };
    const fixtures = buildFixturesFromSamples(samples, inf, transform);
    expect(fixtures).toHaveLength(2);
    expect(fixtures.map((f) => f.event_type).sort()).toEqual(["alpha", "beta"]);

    const result = runFixtures(fixtures, transform);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(canActivate(result)).toBe(true);
  });

  it("activation gate refuses when any fixture fails", () => {
    const samples = [sample({ type: "a", id: 1 }, "e1", "shape_a")];
    const inf = inferred({
      event_types: [
        { cluster_id: "shape_a", name: "alpha", example_event_ids: [], sample_count: 1 },
      ],
    });
    const fixtures = buildFixturesFromSamples(samples, inf, {
      kind: "passthrough",
    });
    // Run with a DIFFERENT transform — fixtures' expected_output won't match.
    const result = runFixtures(fixtures, {
      kind: "envelope",
      event_type_path: "type",
      occurred_at_path: null,
    });
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(canActivate(result)).toBe(false);
    expect(result.failures[0]!.expected).toEqual({ type: "a", id: 1 });
  });

  it("canActivate is false on empty fixture set (codegen must produce fixtures)", () => {
    const result = runFixtures([], { kind: "passthrough" });
    expect(result.total).toBe(0);
    expect(canActivate(result)).toBe(false);
  });

  it("redacts PII from stored fixtures while keeping the pair consistent", () => {
    const samples = [sample({ type: "a", customer: { email: "alice@example.com" } }, "e1", "shape_a")];
    const inf = inferred({
      event_types: [
        { cluster_id: "shape_a", name: "alpha", example_event_ids: [], sample_count: 1 },
      ],
    });
    const transform: GeneratedTransform = {
      kind: "select",
      assignments: { kind: "type", contact: "customer.email" },
    };
    const fixtures = buildFixturesFromSamples(samples, inf, transform);

    // Input is redacted, and the destination even maps the email through — the
    // stored expected output carries the redacted value, not the real address.
    expect(fixtures[0]!.input_payload).toEqual({ type: "a", customer: { email: "[REDACTED]" } });
    expect(fixtures[0]!.expected_output).toEqual({ kind: "a", contact: "[REDACTED]" });
    expect(JSON.stringify(fixtures)).not.toContain("alice@example.com");

    // And the gate still passes — expected == runTransform(redacted input).
    const result = runFixtures(fixtures, transform);
    expect(result.passed).toBe(1);
    expect(canActivate(result)).toBe(true);
  });
});
