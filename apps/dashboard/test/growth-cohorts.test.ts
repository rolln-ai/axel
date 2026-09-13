import { describe, expect, it } from "vitest";
import { growthCohorts, type GrowthActivity } from "../lib/growth-cohorts";
import { signupSource } from "../lib/signup-source";

describe("signup sources", () => {
  it("discards arbitrary text and repeated query parameters", () => {
    for (const input of [undefined, null, "https://example.test/private", "GitHub", ["github", "website"]]) {
      expect(signupSource(input)).toBe("unknown");
    }
    expect(signupSource("github")).toBe("github");
    expect(signupSource("website")).toBe("website");
  });
});

describe("cloud adoption cohorts", () => {
  it("requires first-week activation and a complete second week before counting retention", () => {
    const now = Date.parse("2026-09-13T12:00:00Z");
    const workspace = (id: string, ageDays: number, source = "github") => ({ id, signup_source: source, created_at: new Date(now - ageDays * 86_400_000).toISOString() });
    const activity = (id: string, received = 1, delivered = 1, continued = 1): GrowthActivity => ({ workspace_id: id, received_first_week: received, delivered_first_week: delivered, received_second_week: continued });
    expect(growthCohorts([
      workspace("eligible", 14), workspace("too_new", 13.999), workspace("inactive", 20),
      workspace("never_delivered", 20), workspace("delivery_only", 20), workspace("direct", 20, "unrecognised"),
    ], [activity("eligible"), activity("too_new"), activity("inactive", 1, 1, 0), activity("never_delivered", 1, 0), activity("delivery_only", 0), activity("foreign")], now)).toEqual([
      { source: "github", signups: 5, received: 4, delivered: 3, eligible: 2, continued: 1 },
      { source: "website", signups: 0, received: 0, delivered: 0, eligible: 0, continued: 0 },
      { source: "unknown", signups: 1, received: 0, delivered: 0, eligible: 0, continued: 0 },
    ]);
  });
});
