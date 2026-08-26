import { describe, expect, it } from "vitest";
import { isRouteLookupUnavailableError, routerErrorMessage } from "../src/index";

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

describe("routerErrorMessage", () => {
  it("removes payload and credential echoes before a router dead letter is stored", () => {
    const result = routerErrorMessage(
      new Error(
        'route failed: payload={"password":"hunter2","email":"victim@example.test"}; token=opaque-secret',
      ),
    );

    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("victim@example.test");
    expect(result).not.toContain("opaque-secret");
    expect(result).toContain("[REDACTED]");
  });
});
