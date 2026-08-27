import { describe, expect, it } from "vitest";
import {
  generalizeFixturePayload,
  sanitizeDestinationMappingForPersistence,
  sanitizeDriftDetailForPersistence,
  sanitizeFixtureResultsForPersistence,
  sanitizeInferredSchemaForPersistence,
  sanitizeModelMetadataForPersistence,
} from "../lib/data-contracts/persistence-sanitizer";

describe("Data Contract persistence sanitizer", () => {
  it("keeps structural schema metadata and removes observed values at every depth", () => {
    const persisted = sanitizeInferredSchemaForPersistence({
      event_types: [
        {
          cluster_id: "t:invoice.paid",
          name: "invoice.paid",
          example_event_ids: ["evt_private"],
          sample_count: 2,
        },
      ],
      fields: {
        email: {
          types: ["string"],
          required: true,
          presence: 1,
          distinct_count: 2,
          category: "email",
          examples: ["alice@example.com"],
          enum_values: ["alice@example.com"],
          numeric_range: { min: 10, max: 20 },
        },
      },
      status_fields: [{ path: "status", values: ["secret-status"] }],
      per_cluster: {
        private: {
          fields: { status: { types: ["string"], examples: ["private"] } },
          status_fields: [{ path: "status", values: ["private"] }],
        },
      },
      model_metadata: { sample_count: 2 },
      summary: "Alice paid $20",
    }) as Record<string, unknown>;

    const encoded = JSON.stringify(persisted);
    expect(encoded).not.toContain("alice@example.com");
    expect(encoded).not.toContain("secret-status");
    expect(encoded).not.toContain("evt_private");
    expect(encoded).not.toContain("numeric_range");
    expect(encoded).not.toContain("examples");
    expect(encoded).not.toContain("enum_values");
    expect(persisted.fields).toMatchObject({
      email: {
        types: ["string"],
        required: true,
        presence: 1,
        distinct_count: 2,
        category: "email",
      },
    });
  });

  it("keeps previews transient and strips value-bearing provenance", () => {
    expect(
      sanitizeDestinationMappingForPersistence({
        kind: "postgres",
        destination_id: "dst_1",
        table: "events",
        preview: [{ before: { email: "a@b.com" }, after: { email: "a@b.com" } }],
      }),
    ).toEqual({ kind: "postgres", destination_id: "dst_1", table: "events" });

    expect(
      sanitizeModelMetadataForPersistence({
        model: "model-1",
        sample_count: 3,
        selected_event_type_names: ["customer-secret"],
        patch_likely_cause: "alice@example.com",
      }),
    ).toEqual({ model: "model-1", sample_count: 3 });

    expect(
      sanitizeFixtureResultsForPersistence({
        passed: 1,
        failed: 1,
        total: 2,
        ran_at: "2026-08-27T00:00:00.000Z",
        failures: [{ actual: { email: "a@b.com" } }],
      }),
    ).toEqual({
      passed: 1,
      failed: 1,
      total: 2,
      ran_at: "2026-08-27T00:00:00.000Z",
    });
  });

  it("turns fixtures into type-and-shape templates for transient sources too", () => {
    const generalized = generalizeFixturePayload({
      email: "alice@example.com",
      amount: 4999,
      paid: true,
      nullable: null,
      lines: [
        { sku: "private-sku-1" },
        { sku: "private-sku-2" },
      ],
      "customer@example.com": "value-in-dynamic-key",
    });
    expect(generalized).toEqual({
      email: "[STRING]",
      amount: 0,
      paid: false,
      nullable: null,
      lines: [{ sku: "[STRING]" }],
      field_1: "[STRING]",
    });
    expect(JSON.stringify(generalized)).not.toMatch(/alice|private|customer@example/);
  });

  it("stores drift aggregates without event names or sample values", () => {
    expect(
      sanitizeDriftDetailForPersistence("new_event_type", {
        cluster_id: "t:customer-secret",
        proposed_name: "customer-secret",
        sample_count: 4,
      }),
    ).toEqual({});
  });
});
