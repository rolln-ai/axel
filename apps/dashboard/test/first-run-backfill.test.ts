import { describe, expect, it } from "vitest";
import {
  summarizeBackfillProgress,
  type BackfillProgressInput,
} from "../lib/first-run-backfill";

function input(over: Partial<BackfillProgressInput> = {}): BackfillProgressInput {
  return {
    state: "running",
    settled: false,
    enqueued: 0,
    delivered: 0,
    totalEstimated: null,
    ...over,
  };
}

describe("summarizeBackfillProgress", () => {
  it("keeps going while the job is still enqueueing", () => {
    const r = summarizeBackfillProgress(
      input({ state: "running", enqueued: 50, delivered: 10, totalEstimated: 100 }),
    );
    expect(r.finished).toBe(false);
    expect(r.synced).toBe(10);
    expect(r.percent).toBe(10);
  });

  it("does NOT finish on state=done while deliveries are still draining", () => {
    // 'done' means enqueueing finished, not that events landed. Reporting here
    // would under-count what the user actually got.
    const r = summarizeBackfillProgress(
      input({ state: "done", settled: true, enqueued: 100, delivered: 60, totalEstimated: 100 }),
    );
    expect(r.finished).toBe(false);
    expect(r.synced).toBe(60);
  });

  it("finishes once deliveries catch up to what was enqueued", () => {
    const r = summarizeBackfillProgress(
      input({ state: "done", settled: true, enqueued: 100, delivered: 100, totalEstimated: 100 }),
    );
    expect(r.finished).toBe(true);
    expect(r.incomplete).toBe(false);
    expect(r.percent).toBe(100);
  });

  it("finishes immediately on failed/cancelled and flags it incomplete", () => {
    for (const state of ["failed", "cancelled"] as const) {
      const r = summarizeBackfillProgress(
        input({ state, settled: true, enqueued: 100, delivered: 40, totalEstimated: 100 }),
      );
      expect(r.finished, state).toBe(true);
      expect(r.incomplete, state).toBe(true);
      expect(r.synced, state).toBe(40);
    }
  });

  it("never divides by zero when there's no estimate", () => {
    const r = summarizeBackfillProgress(input({ totalEstimated: null, enqueued: 0, delivered: 0 }));
    expect(Number.isFinite(r.percent)).toBe(true);
    expect(r.percent).toBe(0);
    expect(r.total).toBeGreaterThan(0);
  });

  it("clamps when more events arrive than the estimate predicted", () => {
    // Events can land mid-backfill, so delivered can exceed the estimate.
    const r = summarizeBackfillProgress(
      input({ state: "done", settled: true, enqueued: 150, delivered: 150, totalEstimated: 100 }),
    );
    expect(r.percent).toBe(100);
    expect(r.total).toBe(150);
  });

  it("uses the client's fallback estimate when the job row has none", () => {
    const r = summarizeBackfillProgress(
      input({ totalEstimated: null, fallbackEstimate: 40, delivered: 10 }),
    );
    expect(r.total).toBe(40);
    expect(r.percent).toBe(25);
  });

  it("treats negative counts defensively", () => {
    const r = summarizeBackfillProgress(input({ enqueued: -5, delivered: -1 }));
    expect(r.synced).toBe(0);
    expect(r.percent).toBe(0);
  });

  it("finishes when every replay dead-lettered — the spin-forever bug", () => {
    // A destination the delivery path can't write to fails every replay.
    // Counting only successes left this polling indefinitely at 0.
    const r = summarizeBackfillProgress(
      input({ state: "done", settled: true, enqueued: 1, delivered: 0, failed: 1, totalEstimated: 1 }),
    );
    expect(r.finished).toBe(true);
    expect(r.synced).toBe(0);
    expect(r.failed).toBe(1);
    expect(r.incomplete).toBe(true);
  });

  it("finishes on a partial success once nothing is outstanding", () => {
    const r = summarizeBackfillProgress(
      input({ state: "done", settled: true, enqueued: 10, delivered: 7, failed: 3, totalEstimated: 10 }),
    );
    expect(r.finished).toBe(true);
    expect(r.synced).toBe(7);
    expect(r.failed).toBe(3);
    expect(r.percent).toBe(70);
  });

  it("keeps waiting while some replays are still outstanding", () => {
    const r = summarizeBackfillProgress(
      input({ state: "done", settled: true, enqueued: 10, delivered: 4, failed: 2, totalEstimated: 10 }),
    );
    expect(r.finished).toBe(false);
  });
});
