import "server-only";

import { clickhouse, type ClickhouseQueryable } from "./clickhouse";
import { fetchPayloadForR2Key } from "./sample-payload";

/**
 * Helpers for the AXE-55 live event diff viewer.
 *
 * Given a (workspace, source, event_id, received_at), find the most
 * recent prior event from the same source and return both raw R2
 * payloads. The detail page composes them through json-diff.ts.
 *
 * The "same event_type" half of the AXE-55 spec is a follow-up — for
 * MVP we just take the chronologically previous event from the same
 * source, which catches schema drift in 90% of cases without needing
 * Event-Map-aware event_type extraction here.
 */

export interface PreviousEventRef {
  event_id: string;
  received_at: string;
  r2_key: string;
}

export async function findPreviousEventForSource(
  workspaceId: string,
  sourceId: string,
  beforeReceivedAt: string,
  ch: ClickhouseQueryable = clickhouse(),
): Promise<PreviousEventRef | null> {
  // ClickHouse's events table has a 30-day TTL — anything older than
  // that won't be findable here even if R2 still has the bytes.
  const result = await ch.query<{
    event_id: string;
    received_at_text: string;
    r2_key: string;
  }>(
    // NB: alias the stringified timestamp to `received_at_text`, NOT
    // `received_at`. ClickHouse resolves a SELECT alias ahead of the
    // underlying column, so `toString(received_at) AS received_at` makes the
    // `received_at < parseDateTime64BestEffort(...)` comparison in WHERE/ORDER
    // BY compare a String against DateTime64(3) — "No operation less between
    // String and DateTime64(3)" — and the whole diff panel fails. Same fix as
    // the data-contracts sampler.
    `SELECT event_id,
            toString(received_at) AS received_at_text,
            r2_key
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND source_id = {source_id:String}
        AND received_at < parseDateTime64BestEffort({before:String})
        AND is_test = 0
      ORDER BY received_at DESC
      LIMIT 1`,
    { workspace_id: workspaceId, source_id: sourceId, before: beforeReceivedAt },
  );
  const row = result.rows[0];
  return row ? { event_id: row.event_id, received_at: row.received_at_text, r2_key: row.r2_key } : null;
}

export interface PayloadPair {
  before: { event_id: string; received_at: string; payload: unknown } | null;
  after: { event_id: string; received_at: string; payload: unknown };
}

/**
 * Fetches both payloads in parallel. `before` is null when there's
 * no previous event in the 30-day ClickHouse window.
 */
export async function loadDiffPair(
  workspaceId: string,
  sourceId: string,
  current: { event_id: string; received_at: string; r2_key: string },
): Promise<PayloadPair> {
  const previousRef = await findPreviousEventForSource(
    workspaceId,
    sourceId,
    current.received_at,
  );
  const [afterPayload, beforePayload] = await Promise.all([
    fetchPayloadForR2Key(current.r2_key).catch(() => null),
    previousRef
      ? fetchPayloadForR2Key(previousRef.r2_key).catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    after: {
      event_id: current.event_id,
      received_at: current.received_at,
      payload: afterPayload,
    },
    before: previousRef && beforePayload !== null
      ? {
          event_id: previousRef.event_id,
          received_at: previousRef.received_at,
          payload: beforePayload,
        }
      : null,
  };
}
