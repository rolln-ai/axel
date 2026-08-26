import { describe, expect, it } from "vitest";
import {
  BREAKER_PAUSE_RETRY_MS,
  evaluateBreaker,
  type BreakerRow,
} from "../src/circuit-breaker.ts";

/**
 * State-transition table for the shared breaker decision core. This pins the
 * exact semantics BOTH runtimes (delivery-service node-pg, delivery-edge
 * postgres.js) must honor — including the transitions the edge fork used to
 * lack (open→half_open probe promotion, half_open probe timeout reopen).
 */

const NOW = Date.parse("2026-08-23T12:00:00.000Z");

function row(overrides: Partial<BreakerRow> = {}): BreakerRow {
  return {
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_half_open_at: null,
    circuit_cooldown_seconds: 60,
    delivery_paused: false,
    retry_after_until: null,
    ...overrides,
  };
}

const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe("evaluateBreaker — state-transition table", () => {
  it("closed → deliver", () => {
    expect(evaluateBreaker(row(), NOW)).toEqual({
      action: "decide",
      decision: { decision: "deliver" },
    });
  });

  it("null/unknown state → deliver (never blocks on a missing column)", () => {
    expect(evaluateBreaker(row({ circuit_state: null }), NOW)).toEqual({
      action: "decide",
      decision: { decision: "deliver" },
    });
  });

  it("disabled → skip_dead, and disabled wins over paused (canonical order)", () => {
    const evaluation = evaluateBreaker(
      row({ circuit_state: "disabled", delivery_paused: true }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "decide",
      decision: { decision: "skip_dead", reason: "destination_disabled_manually" },
    });
  });

  it("paused → skip_retry with the 5-minute floor, even when the breaker is open", () => {
    const evaluation = evaluateBreaker(
      row({ delivery_paused: true, circuit_state: "open", circuit_opened_at: iso(0) }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "decide",
      decision: {
        decision: "skip_retry",
        reason: "delivery_paused",
        retry_after_ms: BREAKER_PAUSE_RETRY_MS,
      },
    });
  });

  it("active retry-after window → skip_retry for the remaining window", () => {
    const evaluation = evaluateBreaker(
      row({ retry_after_until: new Date(NOW + 90_000).toISOString() }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "decide",
      decision: {
        decision: "skip_retry",
        reason: "retry_after_window_active",
        retry_after_ms: 90_000,
      },
    });
  });

  it("expired retry-after window is ignored", () => {
    const evaluation = evaluateBreaker(
      row({ retry_after_until: iso(1_000) }),
      NOW,
    );
    expect(evaluation).toEqual({ action: "decide", decision: { decision: "deliver" } });
  });

  it("open + cooldown running → skip_retry for the remainder (1s floor)", () => {
    const evaluation = evaluateBreaker(
      row({ circuit_state: "open", circuit_opened_at: iso(20_000) }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "decide",
      decision: {
        decision: "skip_retry",
        reason: "breaker_open_cooldown_active",
        retry_after_ms: 40_000,
      },
    });
    const nearlyDone = evaluateBreaker(
      row({ circuit_state: "open", circuit_opened_at: iso(59_900) }),
      NOW,
    );
    expect(nearlyDone).toEqual({
      action: "decide",
      decision: {
        decision: "skip_retry",
        reason: "breaker_open_cooldown_active",
        retry_after_ms: 1000, // floored
      },
    });
  });

  it("open + cooldown expired → attempt the open→half_open flip; winner probes, loser retries", () => {
    const evaluation = evaluateBreaker(
      row({ circuit_state: "open", circuit_opened_at: iso(60_000) }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "attempt_half_open_probe",
      won: { decision: "deliver" },
      lost: {
        decision: "skip_retry",
        reason: "half_open_probe_in_flight",
        retry_after_ms: 60_000,
      },
    });
  });

  it("half_open + fresh probe → skip_retry (single-probe rule)", () => {
    const evaluation = evaluateBreaker(
      row({ circuit_state: "half_open", circuit_half_open_at: iso(5_000) }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "decide",
      decision: {
        decision: "skip_retry",
        reason: "half_open_probe_in_flight",
        retry_after_ms: 60_000,
      },
    });
  });

  it("half_open + probe older than the cooldown → reopen (escape valve)", () => {
    const evaluation = evaluateBreaker(
      row({ circuit_state: "half_open", circuit_half_open_at: iso(61_000) }),
      NOW,
    );
    expect(evaluation).toEqual({
      action: "reopen_timed_out_probe",
      decision: {
        decision: "skip_retry",
        reason: "half_open_probe_timed_out",
        retry_after_ms: 60_000,
      },
      elapsed_ms: 61_000,
    });
  });

  it("half_open with NO half_open_at timestamp → reopen with null elapsed", () => {
    const evaluation = evaluateBreaker(
      row({ circuit_state: "half_open", circuit_half_open_at: null }),
      NOW,
    );
    expect(evaluation).toMatchObject({
      action: "reopen_timed_out_probe",
      elapsed_ms: null,
    });
  });

  it("defaults the cooldown to 60s when the column is null", () => {
    const evaluation = evaluateBreaker(
      row({
        circuit_state: "open",
        circuit_opened_at: iso(59_000),
        circuit_cooldown_seconds: null,
      }),
      NOW,
    );
    expect(evaluation).toMatchObject({
      action: "decide",
      decision: { reason: "breaker_open_cooldown_active", retry_after_ms: 1000 },
    });
  });
});
