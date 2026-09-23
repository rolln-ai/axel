import { describe, expect, it } from "vitest";
import { sourceSilenceObservation, incidentTransition, learningWindowEnd, timestamp, type FlowSource } from "../lib/impact-alert-policy";
import { renderImpactEmail } from "../lib/impact-alerts";
import { optedInToImmediate } from "../lib/notification-alerts";

const now = Date.parse("2030-01-14T14:00:00Z");
const source: FlowSource = { id: "src_test", name: "Orders", created_at: "2030-01-13T14:00:00Z", flow_monitoring_enabled: true, alert_after_minutes: null };
const activity = { source_id: source.id, last_received: "2030-01-14 12:00:00.000", samples: 100, typical_gap_seconds: 60 };

describe("impact policy", () => {
  it("identifies pre-destination failures and links to workspace-scoped diagnostics", () => {
    const snapshot = { ...sourceSilenceObservation(source, activity, now)!.snapshot,
      cause: "delivery_failed" as const, failedCount: 2 };
    const email = renderImpactEmail("Example", "ws_test", "delivery_blocked", snapshot, "reminder");
    expect(email.subject).toContain("routing failures need attention");
    expect(email.text).toContain("before a destination was selected");
    expect(email.text).toContain("Check for a successful recovery before replaying");
    expect(email.text).toContain("/sources/src_test");
    expect(email.text).toContain("/workspaces/ws_test/deliveries?status=failed&source=src_test");
    expect(email.html).toContain("status=failed&amp;source=src_test");
    const destination = renderImpactEmail("Example", "ws_test", "delivery_blocked",
      { ...snapshot, destinationId: "dst_test", destinationName: "Warehouse" }, "opened");
    expect(destination.subject).toContain("deliveries to Warehouse");
    expect(destination.text).toContain("source=src_test&destination=dst_test");
    expect(destination.text).not.toContain("before a destination was selected");
  });
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
  it("reports when automatic monitoring can begin for a new source", () => {
    expect(learningWindowEnd(source, now)).toBe(Date.parse("2030-01-20T14:00:00Z"));
    expect(learningWindowEnd({ ...source, alert_after_minutes: 60 }, now)).toBeNull();
    expect(learningWindowEnd({ ...source, created_at: "2030-01-01" }, now)).toBeNull();
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
    // An operator-requested fix closes on the first healthy check, but a
    // still-unhealthy incident keeps reminding.
    expect(incidentTransition({ ...state, acknowledged_until: null, fix_requested_at: "2030-01-14 13:50:00+00" }, false, now)).toBe("recover");
    expect(incidentTransition({ ...state, acknowledged_until: null, fix_requested_at: "2030-01-14 13:50:00+00" }, true, now)).toBe("remind");
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
    const reminder = renderImpactEmail("Example", "ws_test", "source_silent", snapshot, "reminder");
    expect(reminder.subject).toBe("[Example] Still unresolved: Orders stopped receiving data");
    expect(reminder.text).toContain("at most once every 24 hours");
    const hostile = renderImpactEmail("Workspace\r\nBcc: injected", "ws_test", "source_silent", { ...snapshot, sourceName: "<script>alert(1)</script>" }, "opened");
    expect(hostile.subject).not.toMatch(/[\r\n]/);
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
    expect(optedInToImmediate(null)).toBe(true);
    expect(optedInToImmediate({ email_immediate: false })).toBe(false);
  });
});
