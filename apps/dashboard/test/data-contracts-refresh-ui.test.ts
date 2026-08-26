import { describe, expect, it } from "vitest";
import {
  createRefreshInFlightRegistry,
  deriveRefreshPhase,
} from "../lib/data-contracts/refresh-ui";

describe("deriveRefreshPhase", () => {
  it("is idle for useActionState's initial {} state (action not fired yet)", () => {
    // This is the exact pre-hydration / pre-fire render the audit flagged:
    // the old component fell through to the success copy here.
    expect(deriveRefreshPhase({}, false)).toBe("idle");
  });

  it("is pending while the action runs, regardless of prior state", () => {
    expect(deriveRefreshPhase({}, true)).toBe("pending");
    expect(deriveRefreshPhase({ error: "boom" }, true)).toBe("pending");
    expect(deriveRefreshPhase({ notice: "done" }, true)).toBe("pending");
  });

  it("is error when the last completed run failed", () => {
    expect(deriveRefreshPhase({ error: "R2 unreachable" }, false)).toBe("error");
  });

  it("is success only after a completed run set notice or data", () => {
    expect(deriveRefreshPhase({ notice: "No new event types found." }, false)).toBe(
      "success",
    );
    expect(
      deriveRefreshPhase(
        { notice: "Added 2", data: { new_version_id: "emv_2" } },
        false,
      ),
    ).toBe("success");
  });

  it("prefers error over stale success fields", () => {
    // Defensive: a state carrying both never renders the success copy.
    expect(deriveRefreshPhase({ error: "boom", notice: "old" }, false)).toBe("error");
  });
});

describe("createRefreshInFlightRegistry", () => {
  it("begin is an atomic check-and-set: second concurrent trigger is refused", () => {
    const registry = createRefreshInFlightRegistry();
    expect(registry.begin("em_1")).toBe(true);
    // The other trigger (auto-refresh vs. manual button) must not dispatch.
    expect(registry.begin("em_1")).toBe(false);
    expect(registry.isInFlight("em_1")).toBe(true);
  });

  it("tracks contracts independently", () => {
    const registry = createRefreshInFlightRegistry();
    expect(registry.begin("em_1")).toBe(true);
    expect(registry.begin("em_2")).toBe(true);
    registry.end("em_1");
    expect(registry.isInFlight("em_1")).toBe(false);
    expect(registry.isInFlight("em_2")).toBe(true);
  });

  it("end releases so a later refresh can begin; ending twice is a no-op", () => {
    const registry = createRefreshInFlightRegistry();
    expect(registry.begin("em_1")).toBe(true);
    registry.end("em_1");
    registry.end("em_1");
    expect(registry.begin("em_1")).toBe(true);
  });

  it("notifies subscribers on begin and end, but not on no-op end", () => {
    const registry = createRefreshInFlightRegistry();
    let notified = 0;
    const unsubscribe = registry.subscribe(() => {
      notified += 1;
    });
    registry.begin("em_1");
    expect(notified).toBe(1);
    registry.end("em_1");
    expect(notified).toBe(2);
    registry.end("em_1"); // no-op: nothing in flight
    expect(notified).toBe(2);
    unsubscribe();
    registry.begin("em_1");
    expect(notified).toBe(2);
  });

  it("subscribe works unbound (useSyncExternalStore passes the method around)", () => {
    const registry = createRefreshInFlightRegistry();
    const { subscribe } = registry;
    let notified = 0;
    const unsubscribe = subscribe(() => {
      notified += 1;
    });
    registry.begin("em_1");
    expect(notified).toBe(1);
    unsubscribe();
  });
});
