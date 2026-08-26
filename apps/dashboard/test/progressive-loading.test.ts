import { describe, expect, it, vi } from "vitest";
import { resolveWithin } from "../lib/progressive-loading";

describe("progressive loading", () => {
  it("returns the resolved value when work finishes before the budget", async () => {
    await expect(resolveWithin(Promise.resolve("ready"), 100)).resolves.toBe("ready");
  });

  it("returns null when work exceeds the budget", async () => {
    vi.useFakeTimers();
    try {
      const result = resolveWithin(
        new Promise<string>((resolve) => setTimeout(() => resolve("late"), 1_000)),
        100,
      );

      await vi.advanceTimersByTimeAsync(100);
      await expect(result).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves fast failures so callers can render section errors", async () => {
    await expect(resolveWithin(Promise.reject(new Error("boom")), 100)).rejects.toThrow("boom");
  });
});
