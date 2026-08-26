import { describe, expect, it } from "vitest";
import { defaultPipelineName, entityNameError } from "../lib/entity-name";

describe("entityNameError — human-readable display labels", () => {
  it("accepts spaces and mixed case (names are display labels, not slugs)", () => {
    expect(entityNameError("Demo Newsletter Pipeline")).toBeNull();
    expect(entityNameError("Stripe events")).toBeNull();
    expect(entityNameError("Orders to Warehouse")).toBeNull();
  });

  it("still accepts the classic slug forms", () => {
    expect(entityNameError("demo-newsletter-pipeline")).toBeNull();
    expect(entityNameError("my.pipeline_v2")).toBeNull();
    expect(entityNameError("a1")).toBeNull();
  });

  it("rejects leading/trailing whitespace and stray punctuation", () => {
    expect(entityNameError(" leading")).not.toBeNull();
    expect(entityNameError("trailing ")).not.toBeNull();
    expect(entityNameError("-dashfirst")).not.toBeNull();
    expect(entityNameError("dashlast-")).not.toBeNull();
  });

  it("enforces the 2–64 length bound", () => {
    expect(entityNameError("a")).toBe("Name must be 2–64 characters.");
    expect(entityNameError("x".repeat(65))).toBe("Name must be 2–64 characters.");
  });

  it("auto-generates a valid default pipeline name from a source name", () => {
    // The default is "<source> pipeline" — with the space allowed it must pass
    // its own validator (previously it did not).
    const name = defaultPipelineName("Stripe events");
    expect(name).toBe("Stripe events pipeline");
    expect(entityNameError(name)).toBeNull();
  });

  it("keeps the default pipeline name valid for long source names", () => {
    // Truncation happens on the source part, so the result never ends in a
    // space or punctuation the validator would reject.
    for (const len of [54, 55, 56, 63, 64]) {
      const name = defaultPipelineName("x".repeat(len));
      expect(name.length).toBeLessThanOrEqual(64);
      expect(name.endsWith(" pipeline")).toBe(true);
      expect(entityNameError(name)).toBeNull();
    }
  });
});
