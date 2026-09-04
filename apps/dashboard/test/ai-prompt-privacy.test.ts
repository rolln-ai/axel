import { describe, expect, it } from "vitest";
import {
  safeDestinationTypeForAi,
  safeFailureReasonForAi,
  safeHttpStatusForAi,
  summarizeFilterForAi,
  summarizeSerializedFilterForAi,
  summarizeSerializedTransformForAi,
  summarizeTransformForAi,
} from "../lib/ai-prompt-privacy";

describe("AI prompt operational context", () => {
  it("passes only allowlisted destination types and canonical failure reasons", () => {
    expect(safeDestinationTypeForAi("webhook")).toBe("webhook");
    expect(safeDestinationTypeForAi("Private Partner Name")).toBe("[unavailable]");
    expect(safeFailureReasonForAi("delivery_dead")).toBe("delivery_dead");
    expect(safeFailureReasonForAi("filter_private_customer_value")).toBe("filter_error");
    expect(safeFailureReasonForAi("transform_private_customer_value")).toBe(
      "transform_error",
    );
    expect(safeFailureReasonForAi("private_customer_value")).toBe("[unavailable]");
    expect(safeHttpStatusForAi(429)).toBe(429);
    expect(safeHttpStatusForAi(1299)).toBe("[unavailable]");
  });

  it("keeps transform kinds and paths but withholds literal separators", () => {
    const summary = summarizeTransformForAi({
      kind: "collapse_arrays",
      fields: [
        {
          path: "items[].tags",
          format: "join",
          separator: "PRIVATE_SEPARATOR_LITERAL",
        },
      ],
    });

    expect(summary).toEqual({
      kind: "collapse_arrays",
      fields: [
        {
          path: "items[].tags",
          format: "join",
          separator_present: true,
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_SEPARATOR_LITERAL");
  });

  it("keeps filter shape and field paths but withholds event values", () => {
    const summary = summarizeFilterForAi({
      kind: "event_type_in",
      path: "type",
      values: ["private.event.type"],
    });

    expect(summary).toEqual({
      kind: "event_type_in",
      path: "type",
      values_withheld: true,
    });
    expect(JSON.stringify(summary)).not.toContain("private.event.type");
  });

  it("fails closed for malformed serialized DSL", () => {
    expect(summarizeSerializedFilterForAi("not-json")).toEqual({
      kind: "[unavailable]",
    });
    expect(summarizeSerializedTransformForAi("not-json")).toEqual({
      kind: "[unavailable]",
    });
  });
});
