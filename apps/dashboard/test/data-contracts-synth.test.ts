import { describe, expect, it } from "vitest";
import { synthesizePayload } from "../lib/data-contracts/synth";
import type { InferredDataContract } from "../lib/data-contracts/inference";

function schema(over: Partial<InferredDataContract> = {}): InferredDataContract {
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

describe("synthesizePayload", () => {
  it("returns an empty object + null cluster when the map has no clusters", () => {
    const { payload, cluster } = synthesizePayload(schema());
    expect(payload).toEqual({});
    expect(cluster).toBeNull();
  });

  it("prefers observed examples when available — synthetic events look like real events", () => {
    const { payload } = synthesizePayload(
      schema({
        event_types: [
          {
            cluster_id: "h1",
            name: "checkout",
            example_event_ids: [],
            sample_count: 3,
          },
        ],
        fields: {
          id: {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 1,
            examples: ["evt_observed"],
          },
        },
      }),
    );
    expect((payload as { id: string }).id).toBe("evt_observed");
  });

  it("falls back to enum_values[0] and numeric_range midpoint when examples are absent", () => {
    const { payload } = synthesizePayload(
      schema({
        event_types: [
          { cluster_id: "h1", name: "x", example_event_ids: [], sample_count: 1 },
        ],
        fields: {
          status: {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 2,
            category: "enum",
            enum_values: ["paid", "refunded"],
          },
          amount: {
            types: ["number"],
            required: true,
            presence: 1,
            distinct_count: 5,
            category: "numeric",
            numeric_range: { min: 100, max: 500 },
          },
        },
      }),
    );
    expect((payload as { status: string }).status).toBe("paid");
    expect((payload as { amount: number }).amount).toBe(300);
  });

  it("uses category-aware defaults when no observations exist", () => {
    const { payload } = synthesizePayload(
      schema({
        event_types: [{ cluster_id: "h1", name: "x", example_event_ids: [], sample_count: 1 }],
        fields: {
          contact: {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 0,
            category: "email",
          },
          link: {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 0,
            category: "url",
          },
          ccy: {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 0,
            category: "currency_code",
          },
          flag: {
            types: ["boolean"],
            required: true,
            presence: 1,
            distinct_count: 0,
            category: "boolean",
          },
        },
      }),
    );
    const p = payload as Record<string, unknown>;
    expect(p.contact).toBe("test@example.com");
    expect(p.link).toMatch(/^https:\/\//);
    expect(p.ccy).toBe("USD");
    expect(p.flag).toBe(false);
  });

  it("respects nested paths and array markers", () => {
    const { payload } = synthesizePayload(
      schema({
        event_types: [{ cluster_id: "h1", name: "order", example_event_ids: [], sample_count: 1 }],
        fields: {
          "customer.email": {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 1,
            examples: ["a@b.com"],
          },
          "line_items[].sku": {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 1,
            examples: ["sku_001"],
          },
        },
      }),
    );
    expect(payload).toEqual({
      customer: { email: "a@b.com" },
      line_items: [{ sku: "sku_001" }],
    });
  });

  it("picks the requested cluster when cluster_id is provided", () => {
    const map = schema({
      event_types: [
        { cluster_id: "h1", name: "A", example_event_ids: [], sample_count: 1 },
        { cluster_id: "h2", name: "B", example_event_ids: [], sample_count: 1 },
      ],
      per_cluster: {
        h1: {
          fields: { kind: { types: ["string"], required: true, presence: 1, distinct_count: 1, examples: ["a"] } },
          ids: [], timestamps: [], status_fields: [], sensitive_fields: [],
        },
        h2: {
          fields: { kind: { types: ["string"], required: true, presence: 1, distinct_count: 1, examples: ["b"] } },
          ids: [], timestamps: [], status_fields: [], sensitive_fields: [],
        },
      },
    });
    const { payload, cluster } = synthesizePayload(map, "h2");
    expect(cluster?.cluster_id).toBe("h2");
    expect((payload as { kind: string }).kind).toBe("b");
  });
});
