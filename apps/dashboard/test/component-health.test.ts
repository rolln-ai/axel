import { describe, expect, it } from "vitest";
import { deriveStatus, describeStatus, overallStatus, uptimePercent, type ComponentHealth, type UptimeBucket } from "../lib/component-health";

function bucket(status: UptimeBucket["status"]): UptimeBucket {
  return { bucket_start: "2026-05-18T00:00:00Z", status };
}

describe("deriveStatus", () => {
  it("returns unknown when staleness is null", () => {
    expect(deriveStatus(null, 60, null)).toBe("unknown");
  });

  it("returns red when last_error is non-empty regardless of staleness", () => {
    expect(deriveStatus(5, 60, "boom")).toBe("red");
    expect(deriveStatus(0, 60, "boom")).toBe("red");
  });

  it("returns green when staleness is under the expected interval", () => {
    expect(deriveStatus(30, 60, null)).toBe("green");
    expect(deriveStatus(59, 60, null)).toBe("green");
  });

  it("returns yellow when staleness is 1×–2× the expected interval", () => {
    expect(deriveStatus(60, 60, null)).toBe("yellow");
    expect(deriveStatus(119, 60, null)).toBe("yellow");
  });

  it("returns red when staleness is 2× or more the expected interval", () => {
    expect(deriveStatus(120, 60, null)).toBe("red");
    expect(deriveStatus(3600, 60, null)).toBe("red");
  });
});

describe("describeStatus", () => {
  it("gives a human-readable summary per status", () => {
    expect(describeStatus("green")).toMatch(/operational/i);
    expect(describeStatus("yellow")).toMatch(/degraded|stale/i);
    expect(describeStatus("red")).toMatch(/down|stalled/i);
    expect(describeStatus("unknown")).toMatch(/no heartbeat/i);
  });
});

function fakeRow(status: ComponentHealth["status"], component = "x"): ComponentHealth {
  return {
    component,
    environment: "test",
    last_seen: "2026-05-17T00:00:00Z",
    last_tick_count: 0,
    last_error: null,
    metadata: {},
    expected_interval_seconds: 60,
    staleness_seconds: 0,
    status,
  };
}

describe("uptimePercent", () => {
  it("returns null when every bucket is unknown (worker never reported)", () => {
    expect(uptimePercent([bucket("unknown"), bucket("unknown")])).toBe(null);
  });

  it("returns 100 when every observed bucket is green", () => {
    expect(uptimePercent([bucket("green"), bucket("green")])).toBe(100);
  });

  it("excludes unknown buckets from the denominator", () => {
    // 2 green + 2 unknown → 100% over observed
    expect(uptimePercent([bucket("green"), bucket("green"), bucket("unknown"), bucket("unknown")])).toBe(100);
  });

  it("counts only green as up (yellow + red both drag down)", () => {
    // 2 green, 1 yellow, 1 red, 1 unknown → 2/4 = 50%
    const out = uptimePercent([bucket("green"), bucket("green"), bucket("yellow"), bucket("red"), bucket("unknown")]);
    expect(out).toBe(50);
  });
});

describe("overallStatus", () => {
  it("is unknown when there are no rows", () => {
    expect(overallStatus([])).toBe("unknown");
  });

  it("is red if any row is red", () => {
    expect(overallStatus([fakeRow("green"), fakeRow("red"), fakeRow("green")])).toBe("red");
  });

  it("is yellow if any row is yellow or unknown but none are red", () => {
    expect(overallStatus([fakeRow("green"), fakeRow("yellow")])).toBe("yellow");
    expect(overallStatus([fakeRow("green"), fakeRow("unknown")])).toBe("yellow");
  });

  it("is green when every row is green", () => {
    expect(overallStatus([fakeRow("green"), fakeRow("green")])).toBe("green");
  });
});
