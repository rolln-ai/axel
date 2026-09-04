/**
 * ClickHouse event logging for the ingest worker.
 *
 * Every accepted webhook gets a row in the `events` table so the dashboard's
 * /usage and /sources/[id] pages can show what's been received. The write is
 * fire-and-forget via `ctx.waitUntil()` — it MUST NOT block the 202 response.
 *
 * Schema (matches infra/clickhouse/schema.sql):
 *   workspace_id, event_id, source_id, r2_key, received_at, content_type,
 *   size_bytes, shard, is_test, headers_json, query_json, event_type
 *
 * Failure mode: a 5xx from ClickHouse Cloud means the dashboard temporarily
 * misses this event in its analytics views. The event itself is still in R2
 * and on the queue, so delivery is unaffected. `insertRows` logs the failure
 * and moves on.
 */

import {
  insertRows,
  toClickhouseDateTime,
  type ClickhouseInsertEnv,
  type QueueMessage,
} from "@axel/shared";

export type ClickhouseLogEnv = ClickhouseInsertEnv;

export async function logEventToClickhouse(
  env: ClickhouseLogEnv,
  message: QueueMessage,
): Promise<void> {
  if (!env.CLICKHOUSE_URL) return; // Logging disabled — analytics views go empty.

  const row = {
    workspace_id: message.workspace_id,
    event_id: message.event_id,
    source_id: message.source_id,
    r2_key: message.r2_key,
    received_at: toClickhouseDateTime(message.received_at),
    content_type: message.content_type,
    size_bytes: message.size_bytes,
    shard: message.shard,
    is_test: message.is_test === true,
    // Defense in depth for rolling upgrades and callers outside public ingest:
    // request metadata values are never part of the analytics boundary.
    headers_json: "{}",
    query_json: "{}",
    // '' default matches the LowCardinality(String) DEFAULT '' column, so an
    // older producer that omits the field still inserts cleanly.
    event_type: message.event_type ?? "",
  };

  // skipUnknownFields tolerates deploy ordering: if this worker ships before
  // the `event_type` column is added, the unknown field is skipped instead of
  // failing the whole insert (the event just stays untyped until backfill).
  // Harmless once the column exists.
  await insertRows(env, "events", [row], { skipUnknownFields: true });
}
