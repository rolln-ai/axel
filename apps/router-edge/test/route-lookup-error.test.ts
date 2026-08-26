import { describe, expect, it } from "vitest";
import { isRouteLookupUnavailableError } from "../src/index";

describe("isRouteLookupUnavailableError", () => {
  it.each([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530])(
    "classifies internal route %s responses as transient",
    (status) => {
      expect(
        isRouteLookupUnavailableError(
          new Error(`internal_routes_${status}: upstream unavailable`),
        ),
      ).toBe(true);
    },
  );

  it.each([500, 501, 528, 529])("keeps internal route %s responses actionable", (status) => {
    expect(
      isRouteLookupUnavailableError(new Error(`internal_routes_${status}: application failure`)),
    ).toBe(false);
  });

  it("does not classify unrelated errors", () => {
    expect(isRouteLookupUnavailableError(new Error("fetch failed"))).toBe(false);
  });
});
