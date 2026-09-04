/**
 * ClickHouse `events` logging for pull-source records. Same row shape as the
 * ingest worker's writer so the dashboard's analytics views see pull and push
 * events identically; the shared `insertRows` helper owns the URL/header and
 * fire-and-forget error handling.
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
  if (!env.CLICKHOUSE_URL) return;

  const row = {
    workspace_id: message.workspace_id,
    event_id: message.event_id,
    source_id: message.source_id,
    r2_key: message.r2_key,
    received_at: toClickhouseDateTime(message.received_at),
    content_type: message.content_type,
    size_bytes: message.size_bytes,
    shard: message.shard,
    // MUST be threaded from the queue message: the billing rollup keys off
    // is_test, and omitting the field let the ClickHouse column default apply
    // instead of the message's value (drift from the ingest-worker writer).
    is_test: message.is_test === true,
    // Pull record metadata may contain customer identifiers. Analytics keeps
    // only the dedicated bounded scalar columns, never request-style maps.
    headers_json: "{}",
    query_json: "{}",
    event_type: message.event_type ?? "",
  };

  // skipUnknownFields tolerates deploy ordering before new columns exist —
  // skip the unknown field rather than failing the insert.
  await insertRows(env, "events", [row], { skipUnknownFields: true });
}
