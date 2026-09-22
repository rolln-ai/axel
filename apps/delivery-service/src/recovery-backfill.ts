import type { Pool, PoolClient } from "pg";

export interface RecoveryScope {
  workspace_id: string;
  route_id: string;
  source_id: string;
  recovery_destination_id?: string | null;
  recovery_route_updated_at?: string | null;
}

// A recovery batch must keep the same reviewed route, source, workspace and
// sole destination. Lock the route during enqueue; the delivery runtime also
// rechecks destination controls before sending. Worker credentials deliberately
// cannot lock or mutate sources, workspaces, destinations or bindings.
// Ordinary backfills do not opt into this policy.
export async function recoveryRouteReady(db: Pool | PoolClient, job: RecoveryScope, lock = false): Promise<boolean> {
  const result = await db.query(`SELECT r.id
    FROM routes r JOIN sources s ON s.id=r.source_id AND s.workspace_id=r.workspace_id
    JOIN workspaces w ON w.id=r.workspace_id
    JOIN route_destinations rd ON rd.route_id=r.id
    JOIN destinations d ON d.id=rd.destination_id AND d.workspace_id=r.workspace_id
    WHERE r.workspace_id=$1 AND r.id=$2 AND r.source_id=$3
      AND r.updated_at=$4::timestamptz AND d.id=$5
      AND r.status='active' AND s.status='active' AND w.status='active'
      AND d.status='active' AND NOT d.delivery_paused AND d.circuit_state='closed'
      AND (SELECT count(*) FROM route_destinations WHERE route_id=r.id)=1
    ${lock ? "FOR SHARE OF r" : ""}`,
  [job.workspace_id, job.route_id, job.source_id, job.recovery_route_updated_at, job.recovery_destination_id]);
  return result.rows.length === 1;
}

export async function recoveryDeliveryState(db: PoolClient, job: RecoveryScope, eventIds: string[]): Promise<{
  completed: Set<string>; busy: boolean;
}> {
  const result = await db.query<{ event_id: string; busy: boolean }>(`SELECT split_part(event_id,'#',1) AS event_id,
      state='in_flight' AS busy
    FROM delivery_idempotency
    WHERE workspace_id=$1 AND route_id=$2 AND destination_id=$3
      AND split_part(event_id,'#',1)=ANY($4::text[]) AND state IN ('completed','in_flight')
    UNION ALL
    SELECT split_part(event_id,'#',1) AS event_id, true AS busy
    FROM replay_requests
    WHERE workspace_id=$1 AND source_id=$5 AND split_part(event_id,'#',1)=ANY($4::text[])
      AND state IN ('pending','in_progress')
      AND (scope='all' OR (scope='route' AND route_id=$2)
        OR (scope='destination' AND destination_id=$3 AND (route_id IS NULL OR route_id=$2)))`,
  [job.workspace_id, job.route_id, job.recovery_destination_id, eventIds, job.source_id]);
  // An ambiguous/in-flight delivery is never treated as confirmed success.
  // Keep the cursor in place until it settles; a failed result can then replay.
  return { completed: new Set(result.rows.filter(row => !row.busy).map(row => row.event_id)), busy: result.rows.some(row => row.busy) };
}
