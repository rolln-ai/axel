import "server-only";
import { db, type Queryable } from "./db";
import {
  emitNotification,
  type CreateNotificationInput,
  type NotificationRow,
} from "./notifications";

/**
 * Best-practice nudges — the "we're helping you" lane. Runs weekly from the
 * nudges cron. Every nudge is `info` severity, rides the daily digest (never
 * its own email), and never re-nags once read (the unread dedup index plus a
 * stable per-target dedup key make a fixed nudge fire at most once until the
 * user acts on it).
 *
 * v1 rule: "destination repeatedly failing". A destination whose circuit
 * breaker is open/half-open, or that has piled up consecutive failures, is
 * silently dropping deliveries — exactly the kind of thing a user wants flagged
 * before they notice data missing downstream. Sourced directly from the
 * `destinations` circuit-breaker columns (AXE-27); dead_letters can't be
 * correlated to a destination reliably, so we read the breaker state itself.
 */

const NUDGE_KIND = "best_practice_destination_failing";

export interface NudgeScanSummary {
  destinations_failing: number;
  nudges_emitted: number;
  duration_ms: number;
}

export interface FailingDestinationRow {
  id: string;
  workspace_id: string;
  name: string | null;
  type: string;
  circuit_state: string;
  circuit_consecutive_failures: number;
}

export interface NudgeScanDeps {
  listFailingDestinations?: (client?: Queryable) => Promise<FailingDestinationRow[]>;
  emit?: (input: CreateNotificationInput, client?: Queryable) => Promise<NotificationRow | null>;
  client?: Queryable;
}

export async function runNudgeScan(deps: NudgeScanDeps = {}): Promise<NudgeScanSummary> {
  const start = Date.now();
  // Undefined unless injected; the default helpers fall back to db() themselves,
  // so a fully-injected test never opens a connection.
  const client = deps.client;
  const listFailing = deps.listFailingDestinations ?? listFailingDestinations;
  const emit = deps.emit ?? emitNotification;

  const failing = await listFailing(client);
  const summary: NudgeScanSummary = {
    destinations_failing: failing.length,
    nudges_emitted: 0,
    duration_ms: 0,
  };

  for (const dest of failing) {
    const row = await emit(buildNudge(dest), client);
    if (row) summary.nudges_emitted += 1;
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}

export function buildNudge(dest: FailingDestinationRow): CreateNotificationInput {
  const label = dest.name?.trim() ? dest.name : `${dest.type} destination`;
  const cause =
    dest.circuit_state === "open" || dest.circuit_state === "half_open"
      ? `Its circuit breaker is ${dest.circuit_state.replace("_", "-")} after repeated failures`
      : `It has ${dest.circuit_consecutive_failures} consecutive delivery failures`;
  return {
    workspaceId: dest.workspace_id,
    userId: null,
    kind: NUDGE_KIND,
    severity: "info",
    title: `Destination "${label}" is repeatedly failing`,
    bodyMd: `${cause}, so deliveries to it are being held and will dead-letter if it stays down. Check the destination's URL, credentials, and recent attempts — then reset the breaker once it's healthy.`,
    // Land on the page that actually shows breaker state + the reset
    // control, not the overview (which has neither).
    linkPath: `/destinations/${dest.id}/controls`,
    dedupKey: `nudge:dest_failing:${dest.id}`,
    metadata: {
      destination_id: dest.id,
      circuit_state: dest.circuit_state,
      consecutive_failures: dest.circuit_consecutive_failures,
    },
  };
}

export async function listFailingDestinations(
  client: Queryable = db(),
): Promise<FailingDestinationRow[]> {
  const result = await client.query<FailingDestinationRow>(
    `SELECT id, workspace_id, name, type, circuit_state, circuit_consecutive_failures
       FROM destinations
      WHERE status = 'active'
        AND (
          circuit_state IN ('open', 'half_open')
          OR circuit_consecutive_failures >= circuit_threshold_failures
        )`,
  );
  return result.rows;
}
