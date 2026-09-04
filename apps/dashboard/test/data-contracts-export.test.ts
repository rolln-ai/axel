import { describe, expect, it } from "vitest";
import {
  toJsonSchema,
  toMarkdown,
  toTypeScript,
} from "../lib/data-contracts/export";
import type { InferredDataContract } from "../lib/data-contracts/inference";

function fakeSchema(over: Partial<InferredDataContract> = {}): InferredDataContract {
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

describe("export.toMarkdown", () => {
  it("includes a heading + summary + table per event type", () => {
    const md = toMarkdown(
      fakeSchema({
        summary: "A Stripe-like webhook source.",
        event_types: [
          {
            cluster_id: "h1",
            name: "payment_intent.succeeded",
            example_event_ids: ["e1"],
            sample_count: 5,
          },
        ],
        fields: {
          id: {
            types: ["string"],
            required: true,
            presence: 1,
            distinct_count: 5,
            category: "id",
            examples: ["pi_001"],
            uniqueness: 1,
          },
          amount: {
            types: ["number"],
            required: true,
            presence: 1,
            distinct_count: 5,
            category: "numeric",
            numeric_range: { min: 100, max: 5000 },
          },
          "customer.email": {
            types: ["string"],
            required: false,
            presence: 0.8,
            distinct_count: 4,
            category: "email",
            examples: ["a@b.com"],
          },
        },
        sensitive_fields: [{ path: "customer.email", reason: "deterministic" }],
      }),
      { name: "Newsletter webhook" },
    );
    expect(md).toContain("# Newsletter webhook");
    expect(md).toContain("A Stripe-like webhook source.");
    expect(md).toContain("## payment_intent.succeeded");
    expect(md).toContain("`customer.email`");
    expect(md).toContain("▲ sensitive");
    expect(md).toContain("range 100 – 5000");
  });

  it("falls back gracefully when no event types are detected", () => {
    const md = toMarkdown(fakeSchema(), { name: "Empty source" });
    expect(md).toContain("# Empty source");
    expect(md).toMatch(/No event types detected/);
  });
});

describe("export.toTypeScript", () => {
  it("emits per-cluster interfaces + a union and tags sensitive fields", () => {
    const ts = toTypeScript(
      fakeSchema({
        event_types: [
          {
            cluster_id: "h1",
            name: "payment_intent.succeeded",
            example_event_ids: [],
            sample_count: 1,
          },
        ],
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
          amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
          "customer.email": { types: ["string"], required: false, presence: 0.5, distinct_count: 1 },
        },
        sensitive_fields: [{ path: "customer.email", reason: "deterministic" }],
      }),
      { name: "Newsletter webhook" },
    );
    // tsIdentifier collapses non-alphanumerics into PascalCase words —
    // "Newsletter webhook" becomes "NewsletterWebhook" and
    // "payment_intent.succeeded" → "PaymentIntentSucceeded".
    expect(ts).toMatch(/export interface NewsletterWebhook_PaymentIntentSucceeded/);
    expect(ts).toMatch(/id: string;/);
    expect(ts).toMatch(/amount: number;/);
    expect(ts).toMatch(/email\?: string;.*SENSITIVE/);
    expect(ts).toMatch(/export type NewsletterWebhook = NewsletterWebhook_PaymentIntentSucceeded/);
  });

  it("emits a discriminated union over multiple event types", () => {
    const ts = toTypeScript(
      fakeSchema({
        event_types: [
          { cluster_id: "h1", name: "invoice.paid", example_event_ids: [], sample_count: 1 },
          { cluster_id: "h2", name: "invoice.refunded", example_event_ids: [], sample_count: 1 },
        ],
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
        },
      }),
      { name: "Billing" },
    );
    expect(ts).toMatch(/export type Billing =\n\s+\| Billing_InvoicePaid\n\s+\| Billing_InvoiceRefunded;/);
  });
});

describe("export.toJsonSchema", () => {
  it("emits a 2020-12 JSON Schema with definitions per cluster and required arrays", () => {
    const out = toJsonSchema(
      fakeSchema({
        event_types: [
          {
            cluster_id: "h1",
            name: "payment_intent.succeeded",
            example_event_ids: [],
            sample_count: 1,
          },
        ],
        fields: {
          id: { types: ["string"], required: true, presence: 1, distinct_count: 1 },
          amount: { types: ["number"], required: true, presence: 1, distinct_count: 1 },
          "customer.email": { types: ["string"], required: false, presence: 0.5, distinct_count: 1 },
        },
        sensitive_fields: [{ path: "customer.email", reason: "deterministic" }],
      }),
      { name: "Newsletter demo" },
    );
    expect(out.$schema).toMatch(/2020-12/);
    expect((out.$defs as Record<string, unknown>).PaymentIntentSucceeded).toBeDefined();
    const def = (out.$defs as Record<string, Record<string, unknown>>).PaymentIntentSucceeded!;
    expect(def.required).toEqual(["id", "amount"]);
    const props = def.properties as Record<string, Record<string, unknown>>;
    expect(props.customer).toBeDefined();
    const email = (props.customer!.properties as Record<string, Record<string, unknown>>).email!;
    expect(email["x-sensitive"]).toBe(true);
  });

  it("uses $ref for single event type, oneOf for multiple", () => {
    const single = toJsonSchema(
      fakeSchema({
        event_types: [{ cluster_id: "h1", name: "x", example_event_ids: [], sample_count: 1 }],
        fields: { id: { types: ["string"], required: true, presence: 1, distinct_count: 1 } },
      }),
      { name: "S" },
    );
    expect(single.$ref).toBeDefined();
    expect(single.oneOf).toBeUndefined();

    const multi = toJsonSchema(
      fakeSchema({
        event_types: [
          { cluster_id: "h1", name: "a", example_event_ids: [], sample_count: 1 },
          { cluster_id: "h2", name: "b", example_event_ids: [], sample_count: 1 },
        ],
        fields: { id: { types: ["string"], required: true, presence: 1, distinct_count: 1 } },
      }),
      { name: "M" },
    );
    expect(multi.oneOf).toBeDefined();
    expect((multi.oneOf as unknown[])).toHaveLength(2);
  });
});
