import "server-only";
import { db } from "./db";
import { clickhouse } from "./clickhouse";
import { COMPLETED_DELIVERIES_SQL, DEAD_LETTER_COUNTS_SQL, DELIVERY_ACTIVITY_SQL, FLOW_ACTIVITY_SQL, FLOW_HISTORY_SQL, UNATTEMPTED_SQL } from "./impact-alert-queries";
import { sourceSilenceObservation, timestamp, type FlowActivity, type FlowSource, type ImpactObservation, type ImpactSnapshot } from "./impact-alert-policy";
import type { FlowHistoryBucket } from "./source-gap-history";

interface RouteRow {
  id: string; source_id: string; destination_id: string; destination_name: string;
  paused: boolean; route_errored: boolean; unconditional: boolean; created_at: string;
}
interface DeliveryActivity {
  route_id: string; destination_id: string; last_delivered: string | null;
  waiting_count: number; schema_failures: number; auth_failures: number;
}

export async function loadImpactObservations(workspaceId: string): Promise<ImpactObservation[]> {
  const client = db();
  const sources = (await client.query<FlowSource>(
    `SELECT id, name, created_at::text, alert_after_minutes, flow_monitoring_enabled
       FROM sources WHERE workspace_id = $1 AND status = 'active'`, [workspaceId])).rows;
  const routes = (await client.query<RouteRow>(
    `SELECT r.id, r.source_id, d.id AS destination_id, d.name AS destination_name,
            (d.delivery_paused OR d.status = 'disabled' OR d.circuit_state IN ('open', 'disabled')) AS paused,
            (r.status = 'errored') AS route_errored,
            (r.engine = 'declarative' AND NULLIF(trim(r.filter_expression), '') IS NULL
             AND NULLIF(trim(r.transform_script), '') IS NULL AND r.pipeline_graph IS NULL) AS unconditional,
            GREATEST(r.created_at, d.created_at, r.updated_at)::text AS created_at
       FROM routes r JOIN route_destinations rd ON rd.route_id = r.id
       JOIN destinations d ON d.id = rd.destination_id AND d.workspace_id = r.workspace_id
      WHERE r.workspace_id = $1 AND r.status <> 'disabled'`, [workspaceId])).rows;
  const failures = (await client.query<{source_id: string; route_id: string | null; destination_id: string | null; count: string; recent_count: string}>(
    DEAD_LETTER_COUNTS_SQL, [workspaceId])).rows;
  // Analytics errors propagate. An unavailable monitor must never resolve an incident.
  const ch = clickhouse({ unbounded: true, mergeJoins: true, timeoutMs: 20_000, retryTimeouts: false });
  const activity = (await ch.query<FlowActivity>(FLOW_ACTIVITY_SQL, { workspace_id: workspaceId })).rows;
  const history = new Map((await ch.query<{ source_id: string; buckets: FlowHistoryBucket[] }>(FLOW_HISTORY_SQL,
    { workspace_id: workspaceId })).rows.map(row => [row.source_id, row.buckets]));
  const delivery = (await ch.query<DeliveryActivity>(DELIVERY_ACTIVITY_SQL, { workspace_id: workspaceId })).rows;
  const open = (await client.query<{incident_key: string; snapshot: ImpactSnapshot; opened_at: string}>(
    `SELECT incident_key, snapshot, opened_at::text FROM pipeline_incidents WHERE workspace_id = $1 AND resolved_at IS NULL`, [workspaceId])).rows;
  const now = Date.now();
  const observations: ImpactObservation[] = [];
  for (const source of sources) {
    let flow = activity.find(a => a.source_id === source.id);
    if (flow) flow = { ...flow, history: history.get(source.id) };
    const priorSilence = open.find(i => i.incident_key === `source:${source.id}`);
    const previous = priorSilence?.snapshot;
    // Retention expiry cannot make an already-silent source healthy/unmonitored.
    if (!flow && previous) flow = { source_id: source.id, last_received: previous.lastReceived, samples: 20, typical_gap_seconds: previous.thresholdMinutes * 20 };
    const silence = sourceSilenceObservation(source, flow, now);
    const successful = delivery.filter(d => routes.some(r => r.id === d.route_id && r.source_id === source.id))
      .map(d => timestamp(d.last_delivered)).filter((t): t is number => t !== null);
    if (silence) {
      if (priorSilence && (timestamp(flow?.last_received ?? null) ?? 0) <= (timestamp(priorSilence.opened_at) ?? now)) {
        silence.unhealthy = true;
        // Relearning or retention expiry cannot move the goalposts of an open
        // incident. Keep its original window until new traffic is accepted.
        silence.snapshot.thresholdMinutes = priorSilence.snapshot.thresholdMinutes;
        silence.snapshot.thresholdBasis = priorSilence.snapshot.thresholdBasis;
      }
      silence.snapshot.lastDelivered = successful.length ? new Date(Math.max(...successful)).toISOString() : null;
      observations.push(silence);
    } else if (priorSilence && (timestamp(flow?.last_received ?? null) ?? 0) > (timestamp(priorSilence.opened_at) ?? now)) {
      // No automatic window applies right now, for example inside the learning
      // window, but traffic accepted since the incident opened proves recovery.
      // Without new traffic the incident stays open until it can be judged again.
      observations.push({ key: priorSilence.incident_key, kind: "source_silent", unhealthy: false,
        snapshot: { ...priorSilence.snapshot, lastReceived: flow?.last_received ?? priorSilence.snapshot.lastReceived,
          lastDelivered: successful.length ? new Date(Math.max(...successful)).toISOString() : priorSilence.snapshot.lastDelivered } });
    }
    for (const route of routes.filter(r => r.source_id === source.id)) {
      const outcome = delivery.find(d => d.route_id === route.id && d.destination_id === route.destination_id);
      const failedCount = failures.filter(f => f.source_id === source.id && f.route_id === route.id && f.destination_id === route.destination_id)
        .reduce((n, f) => n + Number(f.count), 0);
      let waitingCount = Number(outcome?.waiting_count ?? 0);
      if (route.unconditional) {
        const missing = await ch.query<{waiting_count: number; event_ids: string[] | null}>(UNATTEMPTED_SQL, {
          workspace_id: workspaceId, source_id: source.id, route_id: route.id,
          destination_id: route.destination_id, route_created: route.created_at,
        });
        let unattempted = Number(missing.rows[0]?.waiting_count ?? 0);
        const candidates = missing.rows[0]?.event_ids ?? [];
        // Attempt logging is best effort. A delivery whose claim settled as
        // completed reached the destination even if its analytics row was lost.
        // Ids beyond the retained array stay counted, so the check only ever
        // removes confirmed deliveries.
        if (unattempted > 0 && candidates.length > 0) {
          const settled = await client.query<{count: string}>(COMPLETED_DELIVERIES_SQL,
            [workspaceId, route.id, route.destination_id, candidates]);
          unattempted = Math.max(0, unattempted - Number(settled.rows[0]?.count ?? 0));
        }
        waitingCount += unattempted;
      }
      const lastDelivered = timestamp(outcome?.last_delivered ?? null);
      const key = `delivery:${route.id}:${route.destination_id}`;
      const prior = open.find(i => i.incident_key === key);
      // A dead letter disappearing (including manual dismissal) is not proof
      // that this route recovered. Require a newer successful delivery too.
      const recentFailure = failures.some(f => f.source_id === source.id && f.route_id === route.id
        && f.destination_id === route.destination_id && Number(f.recent_count) > 0);
      const verified = !prior || (lastDelivered !== null && lastDelivered > (timestamp(prior.opened_at) ?? now));
      observations.push({ key, kind: "delivery_blocked", unhealthy: route.paused || route.route_errored || (failedCount > 0 && (Boolean(prior) || recentFailure)) || waitingCount > 0 || !verified,
        snapshot: { sourceId: source.id, sourceName: source.name, destinationId: route.destination_id,
          destinationName: route.destination_name, routeId: route.id, lastReceived: flow?.last_received ?? null,
          lastDelivered: lastDelivered ? new Date(lastDelivered).toISOString() : null,
          failedCount, waitingCount, thresholdMinutes: 30,
          cause: route.route_errored ? "route_errored" : Number(outcome?.schema_failures ?? 0) > 0 ? "schema_mismatch"
            : Number(outcome?.auth_failures ?? 0) > 0 ? "authorization_failed"
              : route.paused ? "destination_paused" : waitingCount > 0 ? "backlog" : "delivery_failed" },
      });
    }
    // Routing failures can have no destination. Keep these visible as well.
    for (const failure of failures.filter(f => f.source_id === source.id && !f.destination_id)) {
      if (Number(failure.recent_count) === 0 && !open.some(i => i.incident_key === `routing:${source.id}:${failure.route_id ?? "all"}`)) continue;
      observations.push({ key: `routing:${source.id}:${failure.route_id ?? "all"}`, kind: "delivery_blocked", unhealthy: true,
        snapshot: { sourceId: source.id, sourceName: source.name, destinationId: null, destinationName: null,
          routeId: failure.route_id, lastReceived: flow?.last_received ?? null,
          lastDelivered: silence?.snapshot.lastDelivered ?? null, failedCount: Number(failure.count),
          waitingCount: 0, thresholdMinutes: 30, cause: "delivery_failed" } });
    }
  }
  for (const incident of open.filter(i => i.incident_key.startsWith("routing:"))) {
    if (observations.some(o => o.key === incident.incident_key)) continue;
    const newer = delivery.find(d => (!incident.snapshot.routeId || d.route_id === incident.snapshot.routeId)
      && routes.some(r => r.id === d.route_id && r.source_id === incident.snapshot.sourceId)
      && (timestamp(d.last_delivered) ?? 0) > (timestamp(incident.opened_at) ?? now));
    if (newer) observations.push({ key: incident.incident_key, kind: "delivery_blocked", unhealthy: false,
      snapshot: { ...incident.snapshot, failedCount: 0, lastDelivered: newer.last_delivered } });
  }
  return observations;
}
