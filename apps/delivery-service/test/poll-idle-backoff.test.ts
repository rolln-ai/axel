import { describe, expect, it } from "vitest";
import { createPollIdleBackoff } from "../src/poll-idle-backoff.ts";

describe("createPollIdleBackoff", () => {
  it("doubles empty-pull delays up to the configured ceiling", () => {
    const backoff = createPollIdleBackoff(1_000, 60_000);

    expect(Array.from({ length: 8 }, () => backoff.nextEmptyDelayMs())).toEqual([
      1_000,
      2_000,
      4_000,
      8_000,
      16_000,
      32_000,
      60_000,
      60_000,
    ]);
  });

  it("resets to the active interval as soon as work is found", () => {
    const backoff = createPollIdleBackoff(1_000, 60_000);

    backoff.nextEmptyDelayMs();
    backoff.nextEmptyDelayMs();
    backoff.nextEmptyDelayMs();
    backoff.reset();

    expect(backoff.nextEmptyDelayMs()).toBe(1_000);
    expect(backoff.nextEmptyDelayMs()).toBe(2_000);
  });

  it("preserves fixed-interval polling when the maximum equals the base", () => {
    const backoff = createPollIdleBackoff(1_000, 1_000);

    expect(Array.from({ length: 4 }, () => backoff.nextEmptyDelayMs())).toEqual([
      1_000,
      1_000,
      1_000,
      1_000,
    ]);
  });

  it("rejects invalid intervals instead of creating a hot loop", () => {
    expect(() => createPollIdleBackoff(0, 60_000)).toThrow(RangeError);
    expect(() => createPollIdleBackoff(1_000, Number.NaN)).toThrow(RangeError);
  });
});
