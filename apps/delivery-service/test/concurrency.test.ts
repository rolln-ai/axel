import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "@axel/shared";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("mapWithConcurrency", () => {
  it("processes every item exactly once", async () => {
    const seen: number[] = [];
    await mapWithConcurrency([10, 20, 30, 40, 50], 2, async (n) => {
      await tick();
      seen.push(n);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50]);
  });

  it("never runs more than `limit` callbacks at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 50 }, (_, i) => i);
    await mapWithConcurrency(items, 8, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });

  it("caps workers at item count when limit exceeds it", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3], 16, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("is a no-op on an empty list", async () => {
    let calls = 0;
    await mapWithConcurrency([], 4, async () => {
      calls += 1;
    });
    expect(calls).toBe(0);
  });

  it("treats a non-positive limit as serial (>=1)", async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2, 3, 4], 0, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBe(1);
  });
});
