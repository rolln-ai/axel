import { describe, expect, it } from "vitest";
import {
  deliveryAttemptErrorCode,
  sanitizeDeliveryAttemptResponseForStorage,
} from "../src/delivery-attempt-privacy.js";

describe("delivery attempt privacy", () => {
  it("keeps operational fields while dropping every provider-controlled string", () => {
    const result = sanitizeDeliveryAttemptResponseForStorage({
      destination_type: "webhook",
      status: 429,
      retry_after_seconds: 30,
      signed: true,
      error: "private-host.example rejected schema customer_private",
      body: "raw-webhook-marker",
      table: "customer_table_marker",
      nested: { value: "nested-marker" },
    });

    expect(result).toEqual({
      destination_type: "webhook",
      http_status: 429,
      retry_after_seconds: 30,
      signed: true,
      error: "delivery_failed",
    });
    expect(JSON.stringify(result)).not.toContain("private-host");
    expect(JSON.stringify(result)).not.toContain("raw-webhook-marker");
    expect(JSON.stringify(result)).not.toContain("customer_table_marker");
    expect(JSON.stringify(result)).not.toContain("nested-marker");
  });

  it("preserves storage-impact codes without retaining schema fields or values", () => {
    expect(sanitizeDeliveryAttemptResponseForStorage({ status: 200, error: "bigquery_schema_mismatch",
      schemaMismatches: [{ path: "private_field", expected: "FLOAT64", existing: "INT64" }], body: "private-value" }))
      .toEqual({ http_status: 200, error: "bigquery_schema_mismatch" });
    expect(deliveryAttemptErrorCode("bigquery_row_rejected")).toBe("bigquery_row_rejected");
  });

  it("normalizes SSRF detail and preserves stable delivery codes", () => {
    expect(deliveryAttemptErrorCode("ssrf_blocked: private target customer-marker"))
      .toBe("ssrf_blocked");
    expect(deliveryAttemptErrorCode("spill_object_missing")).toBe("spill_object_missing");
    expect(deliveryAttemptErrorCode("native_delivery_503")).toBe("native_delivery_503");
  });

  it("drops destination-like customer values outside the runtime allowlist", () => {
    const result = sanitizeDeliveryAttemptResponseForStorage({
      destination_type: "customer_private_table",
      error: "receiver rejected victim@example.test",
    });

    expect(result).toEqual({ error: "delivery_failed" });
    expect(JSON.stringify(result)).not.toContain("customer_private_table");
    expect(JSON.stringify(result)).not.toContain("victim@example.test");
  });
});
