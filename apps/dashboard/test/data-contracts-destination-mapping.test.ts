import { describe, expect, it } from "vitest";
import type { InferredDataContract } from "../lib/data-contracts/inference";
import {
  proposeBigQueryMapping,
  proposeMongoMapping,
  proposePostgresMapping,
  proposeWebhookMapping,
  type MongoIntrospection,
  type PostgresIntrospection,
  type WebhookIntrospection,
} from "../lib/data-contracts/destination-mapping";
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
      prompt_version: "test",
      sample_count: 0,
      llm_enriched: false,
      ms: null,
    },
    ...over,
  };
}

function sample(payload: unknown, eventId = "evt_x"): SampledEvent {
  return {
    event_id: eventId,
    received_at: "2026-05-15",
    shard: 0,
    headers: {},
    payload,
    shape_hash: "h",
  };
}

describe("proposePostgresMapping", () => {
  it("prefers per-column mode when >=80% of leaf fields match by name + type", () => {
    const intro: PostgresIntrospection = {
      table: "billing.events",
      columns: [
        { name: "id", data_type: "uuid", is_nullable: false, is_unique: true },
        { name: "amount", data_type: "integer", is_nullable: false, is_unique: false },
        { name: "currency", data_type: "text", is_nullable: false, is_unique: false },
        { name: "status", data_type: "text", is_nullable: true, is_unique: false },
      ],
    };
    const m = proposePostgresMapping(
      "dst_1",
      intro,
      inferred({
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 5 },
          amount: { types: ["number"], required: true, presence: 1, distinct_count: 5 },
          currency: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
          status: { types: ["string"], required: true, presence: 1, distinct_count: 2 },
        },
        ids: [{ path: "id", uniqueness: 1, name_match: true }],
      }),
      [sample({ id: "evt_1", amount: 100, currency: "usd", status: "paid" })],
    );
    expect(m.mode).toBe("columns");
    expect(m.column_assignments).toEqual({
      id: "id",
      amount: "amount",
      currency: "currency",
      status: "status",
    });
    expect(m.idempotency_column).toBe("id");
    expect(m.preview[0]!.after).toEqual({
      id: "evt_1",
      amount: 100,
      currency: "usd",
      status: "paid",
    });
  });

  it("falls back to JSONB mode when only some columns match", () => {
    const intro: PostgresIntrospection = {
      table: "raw.events",
      columns: [
        { name: "id", data_type: "uuid", is_nullable: false, is_unique: true },
        { name: "payload", data_type: "jsonb", is_nullable: false, is_unique: false },
      ],
    };
    const m = proposePostgresMapping(
      "dst_1",
      intro,
      inferred({
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
          amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
          currency: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        },
        ids: [{ path: "id", uniqueness: 1, name_match: true }],
      }),
      [sample({ id: "evt_1", amount: 100, currency: "usd" })],
    );
    expect(m.mode).toBe("jsonb");
    expect(m.jsonb_column).toBe("payload");
    expect(m.idempotency_column).toBe("id");
    expect(m.preview[0]!.after).toEqual({ payload: { id: "evt_1", amount: 100, currency: "usd" } });
  });

  it("returns a 'no jsonb column' rationale when target has neither matching columns nor a jsonb column", () => {
    const intro: PostgresIntrospection = {
      table: "x.t",
      columns: [
        { name: "other", data_type: "text", is_nullable: false, is_unique: false },
      ],
    };
    const m = proposePostgresMapping(
      "dst_1",
      intro,
      inferred({
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        },
      }),
      [sample({ id: "x" })],
    );
    expect(m.mode).toBe("jsonb");
    expect(m.jsonb_column).toBeUndefined();
    expect(m.rationale).toMatch(/suggest adding/i);
  });

  it("picks the highest-uniqueness id candidate that exists as a unique column", () => {
    const intro: PostgresIntrospection = {
      table: "t",
      columns: [
        { name: "id", data_type: "uuid", is_nullable: false, is_unique: true },
        { name: "event_id", data_type: "uuid", is_nullable: false, is_unique: true },
        { name: "payload", data_type: "jsonb", is_nullable: false, is_unique: false },
      ],
    };
    const m = proposePostgresMapping(
      "dst_1",
      intro,
      inferred({
        ids: [
          { path: "event_id", uniqueness: 1, name_match: true },
          { path: "id", uniqueness: 1, name_match: true },
        ],
        fields: {
          event_id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        },
      }),
      [sample({ id: "1", event_id: "e1" })],
    );
    // event_id is the first id candidate AND a unique column → wins.
    expect(m.idempotency_column).toBe("event_id");
  });
});

describe("proposeMongoMapping", () => {
  it("picks the most-unique id path as _id and projects sensitive fields out", () => {
    const intro: MongoIntrospection = {
      collection: "events",
      observed_fields: ["_id", "type", "amount"],
    };
    const m = proposeMongoMapping(
      "dst_1",
      intro,
      inferred({
        ids: [
          { path: "id", uniqueness: 1, name_match: true },
          { path: "user_id", uniqueness: 0.5, name_match: true },
        ],
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 5 },
          amount: { types: ["number"], required: true, presence: 1, distinct_count: 5 },
          "customer.email": { types: ["string"], required: true, presence: 1, distinct_count: 5 },
        },
        sensitive_fields: [{ path: "customer.email", reason: "deterministic" }],
      }),
      [sample({ id: "evt_1", amount: 100, customer: { email: "a@b.com" } })],
    );
    expect(m.id_path).toBe("id");
    expect(m.projected_paths).toEqual(["id", "amount"]);
    expect(m.preview[0]!.after).toMatchObject({
      _id: "evt_1",
      id: "evt_1",
      amount: 100,
    });
    // Sensitive field NOT in the projected doc.
    expect((m.preview[0]!.after as { customer?: unknown }).customer).toBeUndefined();
  });

  it("warns when no stable id is available", () => {
    const m = proposeMongoMapping(
      "dst_1",
      { collection: "events", observed_fields: [] },
      inferred({
        fields: { foo: { types: ["string"], required: true, presence: 1, distinct_count: 1 } },
      }),
      [sample({ foo: "bar" })],
    );
    expect(m.id_path).toBeNull();
    expect(m.rationale).toMatch(/replays may insert duplicates/i);
  });
});

describe("proposeBigQueryMapping", () => {
  it("uses typed nested records and previews the delivered row", () => {
    const m = proposeBigQueryMapping(
      "dst_bq",
      {
        kind: "schema",
        dataset: "analytics",
        table: "events",
        fields: [{ name: "data", type: "RECORD", mode: "NULLABLE", fields: [] }],
      },
      [sample({ data: { amount: 42, paid: true } })],
    );

    expect(m).toMatchObject({
      kind: "bigquery",
      dataset: "analytics",
      table: "events",
      mode: "typed_records",
    });
    expect(m.preview[0]!.after).toEqual({
      data: { amount: 42, paid: true },
    });
  });
});

describe("proposeWebhookMapping", () => {
  const intro: WebhookIntrospection = { signature_header: "x-axel-signature" };

  it("uses envelope mode when an event-type field is detected", () => {
    const m = proposeWebhookMapping(
      "dst_1",
      intro,
      inferred({
        status_fields: [{ path: "type", values: ["a", "b"] }],
        timestamps: [{ path: "created_at", format: "iso8601" }],
      }),
      [sample({ type: "user.created", created_at: "2026-05-15T00:00:00Z", id: 1 })],
    );
    expect(m.body_strategy).toBe("envelope");
    expect(m.preview[0]!.after).toEqual({
      event_type: "user.created",
      occurred_at: "2026-05-15T00:00:00Z",
      data: { type: "user.created", created_at: "2026-05-15T00:00:00Z", id: 1 },
    });
  });

  it("falls back to passthrough when no event-type signal is present", () => {
    const m = proposeWebhookMapping(
      "dst_1",
      intro,
      inferred(),
      [sample({ id: 1 })],
    );
    expect(m.body_strategy).toBe("passthrough");
    expect(m.preview[0]!.after).toEqual({ id: 1 });
  });
});
