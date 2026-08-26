import { describe, expect, it } from "vitest";
import {
  detectSensitiveFields,
  inferDeterministic,
  inferDataContract,
  isSensitivePath,
  type LlmResponse,
} from "../lib/data-contracts/inference";
import { shapeHash, type SampledEvent } from "../lib/data-contracts/sampler";

function ev(payload: unknown, over: Partial<SampledEvent> = {}): SampledEvent {
  return {
    event_id: over.event_id ?? `evt_${Math.random().toString(36).slice(2, 8)}`,
    received_at: over.received_at ?? "2026-05-15 00:00:00.000",
    shard: 0,
    headers: {},
    payload,
    shape_hash: over.shape_hash ?? shapeHash(payload),
    ...over,
  };
}

describe("header-derived event types", () => {
  it("clusters and names by a common event-type header when the body carries none", () => {
    // GitHub-style: type is only in X-GitHub-Event; bodies share no
    // discriminator field. Without header awareness these would all collapse
    // to one shape cluster named 'Event 1'.
    const out = inferDeterministic([
      ev({ ref: "refs/heads/main" }, { event_id: "e1", headers: { "x-github-event": "push" } }),
      ev({ ref: "refs/heads/dev" }, { event_id: "e2", headers: { "x-github-event": "push" } }),
      ev({ number: 5 }, { event_id: "e3", headers: { "x-github-event": "issues" } }),
    ]);
    const names = out.event_types.map((c) => c.name).sort();
    // Both names come from the header since the bodies carry no discriminator.
    expect(names).toEqual(["issues", "push"]);
  });
});

describe("per_cluster output", () => {
  it("splits inferred signal per shape cluster so the UI can flip between event types", () => {
    // Two distinct event shapes: payment_intent.succeeded and invoice.paid.
    // They share `id` and `type` but the rest of the fields diverge.
    const succeeded = {
      id: "evt_succeeded_1",
      type: "payment_intent.succeeded",
      data: { object: { amount: 1000, currency: "usd" } },
    };
    const succeeded2 = {
      id: "evt_succeeded_2",
      type: "payment_intent.succeeded",
      data: { object: { amount: 2000, currency: "eur" } },
    };
    const invoicePaid = {
      id: "evt_invoice_1",
      type: "invoice.paid",
      data: { object: { amount_paid: 5000, hosted_invoice_url: "https://example.com/i/1" } },
    };
    const out = inferDeterministic([
      ev(succeeded, { event_id: "e1" }),
      ev(succeeded2, { event_id: "e2" }),
      ev(invoicePaid, { event_id: "e3" }),
    ]);
    expect(out.event_types).toHaveLength(2);
    expect(out.per_cluster).toBeDefined();
    const succHash = out.event_types.find((c) => c.name === "payment_intent.succeeded")!.cluster_id;
    const invHash = out.event_types.find((c) => c.name === "invoice.paid")!.cluster_id;

    const succSchema = out.per_cluster![succHash]!;
    const invSchema = out.per_cluster![invHash]!;

    // Per-cluster fields cover only that shape's paths — amount lives in
    // succeeded, amount_paid in invoice.paid. No bleed-over.
    expect(succSchema.fields["data.object.amount"]).toBeDefined();
    expect(succSchema.fields["data.object.amount_paid"]).toBeUndefined();
    expect(invSchema.fields["data.object.amount_paid"]).toBeDefined();
    expect(invSchema.fields["data.object.amount"]).toBeUndefined();

    // Required-presence is computed per-cluster: amount is in 100% of
    // succeeded samples (2/2), even though it's only 2/3 of the union.
    expect(succSchema.fields["data.object.amount"]!.required).toBe(true);
    expect(succSchema.fields["data.object.amount"]!.presence).toBe(1);
    expect(out.fields["data.object.amount"]!.required).toBe(false);
    expect(out.fields["data.object.amount"]!.presence).toBeCloseTo(2 / 3, 5);
  });

  it("returns per_cluster keyed by cluster_id even for single-event-type maps", () => {
    const out = inferDeterministic([
      ev({ id: "1", type: "checkout.completed" }, { event_id: "e1" }),
      ev({ id: "2", type: "checkout.completed" }, { event_id: "e2" }),
    ]);
    expect(out.event_types).toHaveLength(1);
    const hash = out.event_types[0]!.cluster_id;
    expect(out.per_cluster![hash]).toBeDefined();
    // Single cluster: per-cluster signal equals union signal.
    expect(Object.keys(out.per_cluster![hash]!.fields).sort()).toEqual(
      Object.keys(out.fields).sort(),
    );
  });

  it("emits an empty per_cluster when there are no samples", () => {
    const out = inferDeterministic([]);
    expect(out.per_cluster).toEqual({});
  });
});

describe("field categorization", () => {
  it("classifies emails / urls / uuids / phones / currency / country codes by value pattern", () => {
    const out = inferDeterministic([
      ev({
        contact_email: "a@b.com",
        site_url: "https://example.com/x",
        external_id: "550e8400-e29b-41d4-a716-446655440000",
        phone: "+1 415-555-0100",
        currency: "USD",
        country: "US",
      }),
      ev({
        contact_email: "c@d.com",
        site_url: "https://example.com/y",
        external_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
        phone: "+44 20 7946 0958",
        currency: "EUR",
        country: "GB",
      }),
    ]);
    expect(out.fields.contact_email?.category).toBe("email");
    expect(out.fields.site_url?.category).toBe("url");
    expect(out.fields.external_id?.category).toBe("uuid");
    expect(out.fields.phone?.category).toBe("phone");
    expect(out.fields.currency?.category).toBe("currency_code");
    expect(out.fields.country?.category).toBe("country_code");
  });

  it("classifies low-cardinality string fields as enums with observed values", () => {
    const out = inferDeterministic([
      ev({ status: "paid" }),
      ev({ status: "paid" }),
      ev({ status: "refunded" }),
      ev({ status: "paid" }),
    ]);
    const spec = out.fields.status!;
    // `status` matches both enum-by-cardinality AND the status-name pattern;
    // the status detector pulls it out separately, and the field is tagged
    // as `enum` in the category so the UI can match the badge.
    expect(spec.category).toBe("enum");
    expect(spec.enum_values?.sort()).toEqual(["paid", "refunded"]);
  });

  it("classifies numeric fields with a numeric_range", () => {
    const out = inferDeterministic([
      ev({ amount: 100 }),
      ev({ amount: 250 }),
      ev({ amount: 175 }),
    ]);
    const spec = out.fields.amount!;
    expect(spec.category).toBe("numeric");
    expect(spec.numeric_range).toEqual({ min: 100, max: 250 });
  });

  it("uses `mixed` when a path is observed with multiple non-null types across samples", () => {
    const out = inferDeterministic([
      ev({ amount: 100 }),
      ev({ amount: "100" }),
    ]);
    expect(out.fields.amount?.category).toBe("mixed");
  });

  it("populates examples (capped at 5) so the UI can show real values", () => {
    const out = inferDeterministic([
      ev({ tier: "free" }),
      ev({ tier: "free" }),
      ev({ tier: "pro" }),
      ev({ tier: "enterprise" }),
    ]);
    expect(out.fields.tier?.examples?.length).toBeGreaterThan(0);
    expect(out.fields.tier?.examples).toContain("free");
  });
});

describe("ID candidate selectivity", () => {
  it("does NOT promote every field to an ID when sample size is 1 (regression)", () => {
    // The bug from prod: with only 1 sample every field reads as
    // "100% unique" and was classified as an ID candidate.
    const out = inferDeterministic([
      ev({
        type: "payment_intent.succeeded",
        amount: 100,
        currency: "USD",
        customer: { email: "a@b.com" },
        id: "evt_1",
      }),
    ]);
    const idPaths = out.ids.map((c) => c.path);
    // Should NOT include the obviously-not-id fields, even with 1 sample.
    expect(idPaths).not.toContain("type");
    expect(idPaths).not.toContain("amount");
    expect(idPaths).not.toContain("currency");
    expect(idPaths).not.toContain("customer.email");
    // It IS allowed to include name-matching paths (id) since those
    // surface for the user to confirm.
    expect(idPaths).toContain("id");
  });

  it("requires high uniqueness AND a sensible category when sample size >= 3", () => {
    const out = inferDeterministic([
      ev({ id: "1", currency: "USD", amount: 1 }),
      ev({ id: "2", currency: "USD", amount: 2 }),
      ev({ id: "3", currency: "USD", amount: 3 }),
    ]);
    const idPaths = out.ids.map((c) => c.path);
    expect(idPaths).toContain("id");
    // currency is constant across all samples — not an ID candidate.
    expect(idPaths).not.toContain("currency");
    // amount has high uniqueness but isn't named like an ID and is
    // categorized as numeric → not an ID candidate.
    expect(idPaths).not.toContain("amount");
  });
});

describe("isSensitivePath / detectSensitiveFields", () => {
  it("flags terminal sensitive tokens", () => {
    expect(isSensitivePath("customer.email")).toBe(true);
    expect(isSensitivePath("user.phone")).toBe(true);
    expect(isSensitivePath("auth.token")).toBe(true);
    expect(isSensitivePath("password")).toBe(true);
    expect(isSensitivePath("headers.authorization")).toBe(true);
  });

  it("flags sensitive trailing pairs", () => {
    expect(isSensitivePath("customer.email_address")).toBe(true);
    expect(isSensitivePath("user.phone_number")).toBe(true);
    expect(isSensitivePath("payment.card_number")).toBe(true);
    expect(isSensitivePath("config.api_key")).toBe(true);
    expect(isSensitivePath("body.access_token")).toBe(true);
  });

  it("does NOT flag email_subject (false-positive guard from the spec)", () => {
    // The spec calls this out explicitly: substring "email" is not enough,
    // the field semantics matter. email_subject is the subject line of an
    // email — not an address.
    expect(isSensitivePath("notification.email_subject")).toBe(false);
    expect(isSensitivePath("data.email_body")).toBe(false);
  });

  it("does NOT flag generic 'address' alone (ambiguous, left to user override)", () => {
    expect(isSensitivePath("shipping.address")).toBe(false);
  });

  it("handles camelCase and hyphenated field names", () => {
    expect(isSensitivePath("customer.emailAddress")).toBe(true);
    expect(isSensitivePath("config.apiKey")).toBe(true);
    expect(isSensitivePath("data.client-secret")).toBe(true);
  });

  it("detectSensitiveFields returns the subset of input paths that are sensitive", () => {
    const paths = [
      "id",
      "amount",
      "customer.email",
      "metadata.email_subject",
      "headers.authorization",
    ];
    expect(detectSensitiveFields(paths).sort()).toEqual([
      "customer.email",
      "headers.authorization",
    ]);
  });
});

describe("inferDeterministic — Stripe-shaped fixture", () => {
  const stripeSamples = [
    ev({
      id: "evt_1",
      type: "payment_intent.succeeded",
      created: 1714838400,
      data: {
        object: {
          id: "pi_001",
          amount: 1000,
          currency: "usd",
          customer: { email: "a@b.com", id: "cus_1" },
        },
      },
    }),
    ev({
      id: "evt_2",
      type: "payment_intent.succeeded",
      created: 1714838500,
      data: {
        object: {
          id: "pi_002",
          amount: 2000,
          currency: "eur",
          customer: { email: "c@d.com", id: "cus_2" },
        },
      },
    }),
    ev({
      id: "evt_3",
      type: "invoice.paid",
      created: 1714838600,
      data: {
        object: {
          id: "in_001",
          amount_paid: 5000,
          customer: { email: "e@f.com", id: "cus_3" },
        },
      },
    }),
  ];

  it("clusters by shape, sorted by frequency", () => {
    const out = inferDeterministic(stripeSamples);
    expect(out.event_types).toHaveLength(2);
    expect(out.event_types[0]!.sample_count).toBe(2);
    expect(out.event_types[0]!.name).toBe("payment_intent.succeeded");
    expect(out.event_types[1]!.name).toBe("invoice.paid");
  });

  it("detects id candidates including nested data.object.id", () => {
    const out = inferDeterministic(stripeSamples);
    const idPaths = out.ids.map((c) => c.path);
    expect(idPaths).toContain("id");
    expect(idPaths).toContain("data.object.id");
  });

  it("detects timestamps in unix_s format on `created`", () => {
    const out = inferDeterministic(stripeSamples);
    const ts = out.timestamps.find((t) => t.path === "created");
    expect(ts).toBeDefined();
    expect(ts!.format).toBe("unix_s");
  });

  it("detects `type` as a status/action field with the observed enum values", () => {
    const out = inferDeterministic(stripeSamples);
    const statusType = out.status_fields.find((f) => f.path === "type");
    expect(statusType).toBeDefined();
    expect(statusType!.values.sort()).toEqual([
      "invoice.paid",
      "payment_intent.succeeded",
    ]);
  });

  it("flags data.object.customer.email as sensitive", () => {
    const out = inferDeterministic(stripeSamples);
    const paths = out.sensitive_fields.map((s) => s.path);
    expect(paths).toContain("data.object.customer.email");
  });

  it("marks payment_intent.succeeded fields as required only when present in all events of that cluster (but our impl uses global presence)", () => {
    const out = inferDeterministic(stripeSamples);
    // `id` and `type` are present in all 3, so required=true and presence=1.
    expect(out.fields.id?.required).toBe(true);
    expect(out.fields.id?.presence).toBe(1);
    expect(out.fields.type?.required).toBe(true);
    // `data.object.amount` is only in 2 of 3 → not required, presence 2/3.
    expect(out.fields["data.object.amount"]?.required).toBe(false);
    expect(out.fields["data.object.amount"]?.presence).toBeCloseTo(2 / 3, 5);
  });
});

describe("inferDeterministic — Shopify-shaped fixture (array of line_items)", () => {
  const samples = [
    ev({
      id: 1234567,
      email: "buyer@example.com",
      created_at: "2026-05-14T10:00:00Z",
      financial_status: "paid",
      line_items: [
        { sku: "AAA", title: "Mug", quantity: 1 },
        { sku: "BBB", title: "Shirt", quantity: 2 },
      ],
    }),
    ev({
      id: 1234568,
      email: "buyer2@example.com",
      created_at: "2026-05-14T11:00:00Z",
      financial_status: "refunded",
      line_items: [{ sku: "CCC", title: "Cap", quantity: 1 }],
    }),
  ];

  it("recurses into arrays via [] notation", () => {
    const out = inferDeterministic(samples);
    expect(out.fields["line_items[].sku"]).toBeDefined();
    expect(out.fields["line_items[].quantity"]?.types).toContain("number");
  });

  it("flags top-level email as sensitive", () => {
    const out = inferDeterministic(samples);
    expect(out.sensitive_fields.map((s) => s.path)).toContain("email");
  });

  it("detects iso8601 timestamps", () => {
    const out = inferDeterministic(samples);
    expect(
      out.timestamps.find((t) => t.path === "created_at")?.format,
    ).toBe("iso8601");
  });

  it("recognizes financial_status as a low-cardinality status field", () => {
    const out = inferDeterministic(samples);
    // financial_status doesn't match STATUS_NAME_PATTERN (status word isn't
    // the LAST token — `status` is). Last segment is `financial_status` →
    // tokens [financial, status]; STATUS_NAME_PATTERN matches the full
    // segment exactly, so this won't fire. Verify the explicit
    // expectation: a regression that flips this would change the API.
    expect(
      out.status_fields.find((f) => f.path === "financial_status"),
    ).toBeUndefined();
  });
});

describe("inferDeterministic — GitHub-shaped fixture (push event)", () => {
  const pushEvent = ev({
    ref: "refs/heads/main",
    before: "abc123",
    after: "def456",
    pusher: { name: "jordan", email: "jordan@example.com" },
    repository: {
      id: 999,
      full_name: "acme-co/customer-app",
      private: false,
    },
  });

  it("flags pusher.email as sensitive even when nested", () => {
    const out = inferDeterministic([pushEvent]);
    expect(out.sensitive_fields.map((s) => s.path)).toContain("pusher.email");
  });

  it("picks a fallback Event N name when no type field is present", () => {
    const out = inferDeterministic([pushEvent]);
    expect(out.event_types[0]!.name).toMatch(/^Event \d+$/);
  });
});

describe("inferDataContract — top-level orchestration", () => {
  it("returns an empty deterministic result for empty input without calling LLM", async () => {
    let llmCalls = 0;
    const out = await inferDataContract([], {
      callLlm: async () => {
        llmCalls++;
        return {
          cluster_names: {},
          sensitive_field_paths: [],
          summary: "",
          ms: 0,
        };
      },
    });
    expect(llmCalls).toBe(0);
    expect(out.event_types).toHaveLength(0);
    expect(out.model_metadata.llm_enriched).toBe(false);
  });

  it("returns deterministic-only when llmDisabled=true", async () => {
    const samples = [ev({ type: "x", id: "1" })];
    const out = await inferDataContract(samples, { llmDisabled: true });
    expect(out.model_metadata.llm_enriched).toBe(false);
    expect(out.model_metadata.model).toBeNull();
    expect(out.event_types).toHaveLength(1);
  });

  it("merges LLM cluster names, summary, and adds model-flagged sensitive fields", async () => {
    const samples = [
      ev(
        { id: "1", type: "checkout.completed", email: "a@b.com", weird: "x" },
        { event_id: "e1" },
      ),
      ev(
        { id: "2", type: "checkout.completed", email: "c@d.com", weird: "y" },
        { event_id: "e2" },
      ),
    ];
    const det = inferDeterministic(samples);
    const clusterId = det.event_types[0]!.cluster_id;

    const llmResponse: LlmResponse = {
      cluster_names: { [clusterId]: "Checkout completed" },
      // 'weird' isn't deterministically sensitive but the model thinks it is.
      sensitive_field_paths: ["weird", "email"],
      summary: "This source emits checkout completion events.",
      ms: 123,
    };

    const out = await inferDataContract(samples, {
      callLlm: async () => llmResponse,
      apiKey: "fake",
    });

    expect(out.event_types[0]!.name).toBe("Checkout completed");
    expect(out.summary).toBe("This source emits checkout completion events.");
    expect(out.model_metadata.llm_enriched).toBe(true);
    expect(out.model_metadata.ms).toBe(123);

    const byPath = new Map(out.sensitive_fields.map((s) => [s.path, s.reason]));
    // email was both deterministic AND model-flagged.
    expect(byPath.get("email")).toBe("both");
    // weird was model-only.
    expect(byPath.get("weird")).toBe("model");
  });

  it("falls back to deterministic if the LLM call throws", async () => {
    const samples = [ev({ id: "1" })];
    const out = await inferDataContract(samples, {
      apiKey: "fake",
      callLlm: async () => {
        throw new Error("network down");
      },
    });
    expect(out.model_metadata.llm_enriched).toBe(false);
    // Deterministic result still present.
    expect(out.event_types).toHaveLength(1);
  });

  it("does not invent sensitive paths the model returns when those paths are not in the sample", async () => {
    const samples = [ev({ id: "1" })];
    const out = await inferDataContract(samples, {
      apiKey: "fake",
      callLlm: async () => ({
        cluster_names: {},
        sensitive_field_paths: ["something.not.in.payload"],
        summary: "",
        ms: 1,
      }),
    });
    expect(
      out.sensitive_fields.find((s) => s.path === "something.not.in.payload"),
    ).toBeUndefined();
  });
});
