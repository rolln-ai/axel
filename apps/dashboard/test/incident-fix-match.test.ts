import { describe, expect, it } from "vitest";
import { assignGroupsToIncidents, groupBelongsToIncident, incidentIsFixable, incidentScope } from "../lib/incident-fix-match";
import type { ImpactSnapshot } from "../lib/impact-alert-policy";
import type { InboxGroup } from "../lib/inbox";

const snapshot = (over: Partial<ImpactSnapshot> = {}): ImpactSnapshot => ({
  sourceId: "src_a", sourceName: "Chargebee", destinationId: "dst_a", destinationName: "BigQuery", routeId: "rt_a",
  lastReceived: null, lastDelivered: null, failedCount: 11, waitingCount: 0, thresholdMinutes: 30, cause: "delivery_failed", ...over,
});
const group = (over: Partial<InboxGroup> = {}): InboxGroup => ({
  fingerprint: "fp", count: 3, resolved_24h: 0, first_seen: "", last_seen: "", last_resolved_at: null, exemplar_id: "1",
  reason: "delivery_dead", message_excerpt: "", source_id: "src_a", destination_id: "dst_a", route_id: "rt_a",
  muted_until: null, muted_reason: null, ...over,
});

describe("incident fix matching", () => {
  it("ties a group to the incident with the same source, route and destination", () => {
    const scope = incidentScope(snapshot());
    expect(groupBelongsToIncident(group(), scope)).toBe(true);
    expect(groupBelongsToIncident(group({ source_id: "src_b" }), scope)).toBe(false);
    expect(groupBelongsToIncident(group({ route_id: "rt_b" }), scope)).toBe(false);
    expect(groupBelongsToIncident(group({ destination_id: null }), scope)).toBe(false);
  });
  it("lets a routing incident own only destination-less groups", () => {
    const scope = incidentScope(snapshot({ destinationId: null, routeId: null }));
    expect(groupBelongsToIncident(group({ destination_id: null, route_id: null }), scope)).toBe(true);
    expect(groupBelongsToIncident(group(), scope)).toBe(false);
  });
  it("assigns each group to one incident and keeps the leftovers", () => {
    const a = { id: "inc_a", snapshot: snapshot() };
    const b = { id: "inc_b", snapshot: snapshot({ sourceId: "src_b", routeId: "rt_b" }) };
    const orphan = group({ fingerprint: "orphan", source_id: "src_c" });
    const { byIncident, unassigned } = assignGroupsToIncidents([a, b], [group(), group({ fingerprint: "fp2", source_id: "src_b", route_id: "rt_b" }), orphan]);
    expect(byIncident.get(a)?.map((g) => g.fingerprint)).toEqual(["fp"]);
    expect(byIncident.get(b)?.map((g) => g.fingerprint)).toEqual(["fp2"]);
    expect(unassigned).toEqual([orphan]);
  });
  it("offers the fix only for blocked deliveries", () => {
    expect(incidentIsFixable({ kind: "delivery_blocked", snapshot: snapshot() })).toBe(true);
    expect(incidentIsFixable({ kind: "delivery_blocked", snapshot: snapshot({ cause: "schema_mismatch" }) })).toBe(true);
    expect(incidentIsFixable({ kind: "source_silent", snapshot: snapshot({ cause: "no_traffic" }) })).toBe(false);
  });
});
