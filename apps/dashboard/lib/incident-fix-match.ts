import type { ImpactSnapshot } from "./impact-alert-policy";
import type { InboxGroup } from "./inbox";

/**
 * Pure helpers that tie a data flow incident to the dead-letter groups it
 * covers. An incident is keyed on (source, route, destination); groups are
 * keyed on a message fingerprint but carry the same three ids, so matching
 * is a plain comparison. Kept dependency-free so the Inbox page and tests
 * can share it.
 */

export interface IncidentScope {
  sourceId: string;
  routeId: string | null;
  destinationId: string | null;
}

export function incidentScope(snapshot: Pick<ImpactSnapshot, "sourceId" | "routeId" | "destinationId">): IncidentScope {
  return {
    sourceId: snapshot.sourceId,
    routeId: snapshot.routeId ?? null,
    destinationId: snapshot.destinationId ?? null,
  };
}

export function groupBelongsToIncident(group: Pick<InboxGroup, "source_id" | "route_id" | "destination_id">, scope: IncidentScope): boolean {
  if (group.source_id !== scope.sourceId) return false;
  if ((group.route_id ?? null) !== scope.routeId) return false;
  // Routing failures have no destination; an incident without a destination
  // only owns groups that also lack one.
  return (group.destination_id ?? null) === scope.destinationId;
}

/** Split groups into per-incident buckets plus the leftovers no incident covers. */
export function assignGroupsToIncidents<T extends { snapshot: ImpactSnapshot }>(
  incidents: T[],
  groups: InboxGroup[],
): { byIncident: Map<T, InboxGroup[]>; unassigned: InboxGroup[] } {
  const byIncident = new Map<T, InboxGroup[]>();
  for (const incident of incidents) byIncident.set(incident, []);
  const unassigned: InboxGroup[] = [];
  for (const group of groups) {
    const owner = incidents.find((incident) => groupBelongsToIncident(group, incidentScope(incident.snapshot)));
    if (owner) byIncident.get(owner)!.push(group);
    else unassigned.push(group);
  }
  return { byIncident, unassigned };
}

/** Can the Inbox's one-click fix act on this incident at all? */
export function incidentIsFixable(incident: { kind: string; snapshot: ImpactSnapshot }): boolean {
  return incident.kind === "delivery_blocked" && incident.snapshot.cause !== "no_traffic";
}
