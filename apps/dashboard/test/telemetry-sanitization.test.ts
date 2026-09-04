import { describe, expect, it } from "vitest";
import { sanitizeTelemetryValue } from "../lib/telemetry-sanitization";

describe("dashboard telemetry sanitization", () => {
  it("keeps only allowlisted operational tag values", () => {
    expect(
      sanitizeTelemetryValue({
        component: "billing_checkout",
        phase: "job",
        http_status: 503,
      }),
    ).toEqual({
      component: "billing_checkout",
      phase: "job",
      http_status: 503,
    });
  });

  it("collapses customer and credential values instead of exporting them", () => {
    const result = sanitizeTelemetryValue({
      component: "customer_private_component",
      detail: "receiver echoed victim@example.test and private-webhook-marker",
      authorization: "Bearer private-credential",
    });
    const serialized = JSON.stringify(result);

    expect(result).toEqual({
      component: "operation_failed",
      detail: "operation_failed",
      authorization: "[REDACTED]",
    });
    expect(serialized).not.toContain("victim@example.test");
    expect(serialized).not.toContain("private-webhook-marker");
    expect(serialized).not.toContain("private-credential");
  });
});
