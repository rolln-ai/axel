/** Pure incident policy. A missing telemetry result is never a healthy result. */
import { historicalGapAllowance, observedGapBaseline, type FlowHistoryBucket } from "./source-gap-history";

/** Automatic silence alerts wait until a source has a week of accepted traffic to learn from. */
export const LEARNING_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60_000;

/** When automatic monitoring can start at the earliest, or null once the window has passed. */
export function learningWindowEnd(source: Pick<FlowSource, "created_at" | "alert_after_minutes">, now: number): number | null {
  if (source.alert_after_minutes) return null;
  const created = timestamp(source.created_at);
  if (created === null) return null;
  const end = created + LEARNING_WINDOW_DAYS * DAY_MS;
  return end > now ? end : null;
}
export type ImpactKind = "source_silent" | "delivery_blocked";
export type ImpactPhase = "opened" | "reminder" | "recovered";

export interface FlowSource {
  id: string;
  name: string;
  created_at: string;
  alert_after_minutes: number | null;
  flow_monitoring_enabled: boolean;
}

export interface FlowActivity {
  source_id: string;
  last_received: string | null;
  samples: number;
  typical_gap_seconds: number;
  history?: FlowHistoryBucket[];
}

export interface ImpactSnapshot {
  sourceId: string;
  sourceName: string;
  destinationId: string | null;
  destinationName: string | null;
  routeId: string | null;
  lastReceived: string | null;
  lastDelivered: string | null;
  failedCount: number;
  waitingCount: number;
  thresholdMinutes: number;
  thresholdBasis?: "configured" | "recent_cadence" | "historical_pattern" | "observed_gap";
  cause: "no_traffic" | "delivery_failed" | "schema_mismatch" | "authorization_failed" | "backlog" | "destination_paused";
}

export interface ImpactObservation {
  key: string;
  kind: ImpactKind;
  unhealthy: boolean;
  snapshot: ImpactSnapshot;
}

export function timestamp(value: string | null): number | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return Date.parse(value);
  let normalized = value.replace(" ", "T");
  normalized = normalized.replace(/([+-]\d{2})$/, "$1:00");
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(normalized)) normalized += "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

export function sourceSilenceObservation(source: FlowSource, activity: FlowActivity | undefined, now: number): ImpactObservation | null {
  if (!source.flow_monitoring_enabled) return null;
  // Automatic monitoring needs an established sample. Sparse/new sources can
  // explicitly set their expected maximum gap, including time to first event.
  const automatic = activity && activity.samples >= 20 && activity.typical_gap_seconds > 0;
  if (!source.alert_after_minutes && !automatic) return null;
  const last = timestamp(activity?.last_received ?? null);
  const observed = !source.alert_after_minutes && last && activity?.history
    ? observedGapBaseline(activity.history, last) : null;
  if (observed) {
    // Learning window: the first week of accepted traffic sets the baseline
    // and raises no automatic alerts. An explicit gap skips this window.
    const firstSeen = observed.firstReceived ?? timestamp(source.created_at);
    if (firstSeen !== null && now - firstSeen < LEARNING_WINDOW_DAYS * DAY_MS) return null;
  }
  const cadenceMinutes = Math.max(30, Math.ceil((activity?.typical_gap_seconds ?? 0) * 3 / 60));
  const historyMinutes = !source.alert_after_minutes && last && activity?.history
    ? Math.ceil(historicalGapAllowance(activity.history, last) / 60_000) : 0;
  // The longest completed gap in retained history, with the same 25% grace
  // as the recurring pattern. One long quiet period is enough to count.
  const observedMinutes = observed ? Math.ceil(observed.longestGapMs * 1.25 / 60_000) : 0;
  const thresholdMinutes = source.alert_after_minutes
    ?? Math.min(10080, Math.max(cadenceMinutes, historyMinutes, observedMinutes));
  const thresholdBasis = source.alert_after_minutes ? "configured"
    : observedMinutes > Math.max(cadenceMinutes, historyMinutes) ? "observed_gap"
      : historyMinutes > cadenceMinutes ? "historical_pattern" : "recent_cadence";
  const start = last ?? timestamp(source.created_at);
  if (start === null) return null;
  return {
    key: `source:${source.id}`,
    kind: "source_silent",
    unhealthy: now - start > thresholdMinutes * 60_000,
    snapshot: {
      sourceId: source.id, sourceName: source.name, destinationId: null, destinationName: null, routeId: null,
      lastReceived: activity?.last_received ?? null, lastDelivered: null,
      failedCount: 0, waitingCount: 0, thresholdMinutes, thresholdBasis, cause: "no_traffic",
    },
  };
}

export interface IncidentState {
  healthy_since: string | null;
  acknowledged_until: string | null;
  next_reminder_at: string;
  /** Set when an operator clicked Fix in the Inbox. */
  fix_requested_at?: string | null;
}

export function incidentTransition(state: IncidentState, unhealthy: boolean, now: number): "observe" | "healthy" | "recover" | "remind" {
  if (!unhealthy) {
    // An operator-driven fix has already been verified by this healthy
    // observation (no unresolved failures and a newer successful delivery),
    // so the alert clears at once instead of after 15 quiet minutes.
    if (timestamp(state.fix_requested_at ?? null) !== null) return "recover";
    const healthySince = timestamp(state.healthy_since);
    return healthySince !== null && now - healthySince >= 15 * 60_000 ? "recover" : "healthy";
  }
  const acknowledgement = timestamp(state.acknowledged_until);
  if (acknowledgement !== null && acknowledgement > now) return "observe";
  return now >= (timestamp(state.next_reminder_at) ?? Infinity) ? "remind" : "observe";
}

function label(value: string): string { return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, 120); }
function time(value: string | null): string {
  const ms = timestamp(value);
  return ms === null ? "not observed" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

/** Only controlled templates and configuration labels reach email, never connector free text. */
export function impactMessage(kind: ImpactKind, snapshot: ImpactSnapshot, phase: ImpactPhase): { title: string; body: string } {
  const source = label(snapshot.sourceName);
  const target = snapshot.destinationName ? label(snapshot.destinationName) : "its destination";
  const title = phase === "recovered"
    ? `${source}: ${kind === "source_silent" ? "incoming traffic resumed" : "delivery recovered"}`
    : kind === "source_silent" ? `${source} stopped receiving data`
      : snapshot.cause === "schema_mismatch" ? `${source}: ${target} cannot store some events`
        : `${source}: deliveries to ${target} need attention`;
  const action = snapshot.cause === "no_traffic"
    ? `No accepted events within the expected ${snapshot.thresholdMinutes}-minute window.${snapshot.thresholdBasis === "historical_pattern" ? " This window includes recurring quiet periods at comparable times in this source's retained 30-day history." : snapshot.thresholdBasis === "observed_gap" ? " This window covers the longest quiet period in this source's retained 30-day history." : ""} Check that the sender's webhook is enabled and uses this source's current credentials. Requests rejected before ingestion are not available for replay in Axel.`
    : snapshot.cause === "schema_mismatch"
      ? "The destination rejected rows with an incompatible schema. Review the mapping and target schema, then replay retained failed events. Axel has not changed existing column types or discarded fields."
      : snapshot.cause === "authorization_failed"
        ? "The destination rejected authentication. Check its credentials and permissions, then replay retained failed events."
        : snapshot.cause === "destination_paused"
          ? "Delivery is paused or the destination is disabled. Review delivery controls and the underlying error before resuming."
          : snapshot.cause === "backlog"
            ? "Accepted events have been waiting over 30 minutes for this destination. Check worker and queue health and destination availability."
            : "Some accepted events could not be delivered. Open the failed deliveries, correct the cause, then replay the retained events.";
  return {
    title: `${phase === "reminder" ? "Still unresolved: " : ""}${title}`,
    body: [
      phase === "recovered" ? "Recovery remained healthy across checks for at least 15 minutes. Historical missing data has not necessarily been backfilled." : action,
      `Source: ${source}. Destination: ${snapshot.destinationName ? target : "see source routes"}.`,
      `Last accepted event: ${time(snapshot.lastReceived)}. Last successful destination delivery: ${time(snapshot.lastDelivered)}.`,
      `Unresolved failed events: ${snapshot.failedCount}. Events waiting over 30 minutes: ${snapshot.waitingCount}.`,
      phase === "recovered" ? "Review the incident period for any provider-side backfill still needed." : "This is one incident. Further reminders are limited to every six hours; acknowledgement pauses them for 24 hours.",
    ].join("\n\n"),
  };
}
