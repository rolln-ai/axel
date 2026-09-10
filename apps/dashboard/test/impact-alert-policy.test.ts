import { describe, expect, it } from "vitest";
import { sourceSilenceObservation, incidentTransition, timestamp, type FlowSource } from "../lib/impact-alert-policy";
import { renderImpactEmail } from "../lib/impact-alerts";
import { optedInToImmediate } from "../lib/notification-alerts";

const now = Date.parse("2030-01-14T14:00:00Z");
const source: FlowSource = { id: "src_test", name: "Orders", created_at: "2030-01-13T14:00:00Z", flow_monitoring_enabled: true, alert_after_minutes: null };
const activity = { source_id: source.id, last_received: "2030-01-14 12:00:00.000", samples: 100, typical_gap_seconds: 60 };

describe("impact policy", () => {
  it("detects source silence even when no failed delivery exists", () => {
    const result = sourceSilenceObservation(source, activity, now)!;
    expect(result.unhealthy).toBe(true);
    expect(result.snapshot.failedCount).toBe(0);
    expect(result.snapshot.thresholdMinutes).toBe(30);
    expect(sourceSilenceObservation(source, { ...activity, last_received: "2030-01-14 13:59:00" }, now)?.unhealthy).toBe(false);
  });
  it("does not invent a baseline for sparse or disabled sources", () => {
    expect(sourceSilenceObservation(source, undefined, now)).toBeNull();
    expect(sourceSilenceObservation(source, { ...activity, samples: 3 }, now)).toBeNull();
    expect(sourceSilenceObservation({ ...source, flow_monitoring_enabled: false }, activity, now)).toBeNull();
    expect(sourceSilenceObservation({ ...source, alert_after_minutes: 60 }, undefined, now)?.unhealthy).toBe(true);
  });
  it("respects scheduled cadence and explicit thresholds", () => {
    expect(sourceSilenceObservation(source, { ...activity, typical_gap_seconds: 86400 }, now)?.unhealthy).toBe(false);
    expect(sourceSilenceObservation({ ...source, alert_after_minutes: 60 }, activity, now)?.snapshot.thresholdMinutes).toBe(60);
  });
  it("requires sustained recovery and honors acknowledgement without hiding recovery", () => {
    const state = { healthy_since: null, acknowledged_until: "2030-01-15 14:00:00+00", next_reminder_at: "2030-01-14 12:00:00+00" };
    expect(incidentTransition(state, true, now)).toBe("observe");
    expect(incidentTransition({ ...state, acknowledged_until: null }, true, now)).toBe("remind");
    expect(incidentTransition(state, false, now)).toBe("healthy");
    expect(incidentTransition({ ...state, healthy_since: "2030-01-14 13:44:00+00" }, false, now)).toBe("recover");
    expect(timestamp("2030-01-14 14:00:00+00")).toBe(now);
    expect(timestamp("1970-01-01 00:00:00")).toBeNull();
  });
  it("renders the actual impact, names, times and next action without connector free text", () => {
    const snapshot = sourceSilenceObservation(source, activity, now)!.snapshot;
    const email = renderImpactEmail("Example", "ws_test", "source_silent", snapshot, "opened");
    expect(email.subject).toBe("[Example] Orders stopped receiving data");
    expect(email.text).toContain("webhook is enabled");
    expect(email.text).toContain("2030-01-14 12:00:00 UTC");
    expect(email.text).toContain("/workspaces/ws_test/inbox");
    expect(email.text).not.toContain("operation_failed");
    const hostile = renderImpactEmail("Workspace\r\nBcc: injected", "ws_test", "source_silent", { ...snapshot, sourceName: "<script>alert(1)</script>" }, "opened");
    expect(hostile.subject).not.toMatch(/[\r\n]/);
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
    expect(optedInToImmediate(null)).toBe(true);
    expect(optedInToImmediate({ email_immediate: false })).toBe(false);
  });
});
