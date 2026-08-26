/**
 * AXE-67 — replay processor wired into delivery-service.
 *
 * The router package exports `processReplayBatch` as a library, but no live
 * process called it. This module is the production glue:
 *
 *   1. Postgres-backed `ReplayStore` claims pending rows atomically so
 *      multiple delivery-service replicas can't double-process the same
 *      replay (UPDATE … WHERE state='pending' RETURNING — single round trip).
 *   2. Postgres-backed `RouteStore` reads the same shape the live router
 *      gets via `/internal/routes` (we're in-process so we skip the HTTP).
 *   3. Postgres-backed `DeadLetterSink` writes directly to `dead_letters`
 *      instead of going via the Cloudflare DLQ → delivery-edge consumer
 *      path the edge router uses — we're Node, we have the pool, do the
 *      INSERT here.
 *   4. R2 raw-payload reads via Cloudflare's account-scoped HTTP API
 *      (mirrors apps/delivery-service/src/cli-api.ts:377).
 *   5. Delivery-queue writes via Cloudflare's Queues HTTP API
 *      (mirrors apps/delivery-service/src/server.ts:427 retry sink).
 *   6. ClickHouse `events` lookup for best-effort hint resolution
 *      (received_at / content_type / headers).
 *
 * The runner is started by `server.ts` and stopped during graceful shutdown
 * so an in-flight replay batch isn't truncated.
 */

import type { Pool } from "pg";
import {
  processReplayBatch,
  startPeriodicRunner,
  type DeliveryQueueSink,
  type EventLogSink,
  type RawPayloadStore,
  type ReplayPayloadHints,
  type ReplayProcessorDeps,
  type ReplayRow,
  type ReplayStore,
  type RouteStore,
  type RouteWithDestinationTypes,
  type RouterDeps,
  type RunnerHandle,
} from "@axel/router";
import type { DeadLetterRecord, DeadLetterSink } from "@axel/router";
import {
  cloudflareR2ObjectUrl,
  deadLetterFingerprint,
  sanitizeConnectorDiagnosticForStorage,
  type QueueSpillWriter,
} from "@axel/shared";
import type { ObjectStoreLike } from "@axel/connectors";
import { advanceReplayJobOnTerminal } from "./replay-job-completion.js";
import { loadActiveRoutes, markRouteErrored } from "./route-store.js";

const REPLAY_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REPLAY_FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(input, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

// Attempt delays for the R2 HTTP API (3 tries total). Mirrors the connector
// backoff shape used elsewhere (e.g. bigquery SCHEMA_PROPAGATION_BACKOFF_MS).
const R2_RETRY_BACKOFF_MS = [0, 100, 300] as const;

/** Cloudflare/R2 statuses worth retrying: 429 + all 5xx, incl. CF edge errors
 *  520–530 — notably 525 "SSL handshake failed", which is transient. */
function isRetryableR2Status(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Read a failed response body for use in an error message.
 *
 * Cloudflare's edge errors (520–530) answer with a full HTML page, not JSON.
 * Splicing the first 200 characters of that into an Error message gives
 * Sentry a title made of `<!DOCTYPE html>` and doctype comments, and the
 * conditional-comment lines get read as stack frames (JAVASCRIPT-38). Collapse
 * HTML to a fixed marker so every edge error of a given status groups as one
 * issue; pass other bodies (the JSON API errors) through as before.
 */
async function errorBodyExcerpt(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return "<unreadable body>";
  }
  const trimmed = text.trim();
  if (/^<(?:!doctype|html)\b/i.test(trimmed)) {
    const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(trimmed)?.[1]?.trim();
    return title ? `<cloudflare html error: ${title}>` : "<cloudflare html error>";
  }
  return trimmed.slice(0, 200);
}

/** Declared body size, or null when the header is absent or unparseable. */
function contentLength(res: Response): number | null {
  const raw = res.headers.get("content-length");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * Fetch an R2 HTTP-API URL, retrying transient edge failures with short
 * backoff. Cloudflare intermittently returns a 525/5xx for a request that
 * succeeds on retry; without this a single blip fails a whole replay (Sentry
 * JAVASCRIPT-38). Returns the final Response — the caller decides how to
 * surface a status that is still failing after the retries are exhausted.
 */
async function fetchR2WithRetry(
  fetchImpl: typeof fetch,
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  let res: Response | undefined;
  for (let attempt = 0; attempt < R2_RETRY_BACKOFF_MS.length; attempt++) {
    const backoff = R2_RETRY_BACKOFF_MS[attempt]!;
    if (backoff > 0) await new Promise((resolve) => setTimeout(resolve, backoff));
    res = await fetchWithTimeout(fetchImpl, input, init);
    if (!isRetryableR2Status(res.status)) return res;
  }
  return res!;
}

// ---- ReplayStore (Postgres) ---- //

export function createPgReplayStore(pool: Pool): ReplayStore {
  return {
    /**
     * Atomic claim. The single UPDATE … RETURNING transitions rows from
     * `pending` to `in_progress` and gives them to us in one round trip —
     * race-safe across replicas.
     */
    async claimPending(limit: number): Promise<ReplayRow[]> {
      const result = await pool.query<ReplayRow>(
        `WITH reclaimed AS (
           UPDATE replay_requests
              SET state = 'pending',
                  started_at = NULL,
                  error_message = 'Reclaimed stale in-progress replay.'
            WHERE state = 'in_progress'
              AND started_at < now() - interval '10 minutes'
            RETURNING id
         ),
         claimed AS (
           SELECT id
             FROM replay_requests
            WHERE state = 'pending'
            ORDER BY requested_at ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         UPDATE replay_requests rr
            SET state = 'in_progress',
                started_at = now()
           FROM claimed
          WHERE rr.id = claimed.id
        RETURNING rr.id, rr.workspace_id, rr.event_id, rr.source_id, rr.r2_key,
                  rr.scope, rr.route_id, rr.destination_id, rr.reason,
                  rr.replay_job_id`,
        [limit],
      );
      // Stamp the tracked replay_jobs row 'running' the first time any of its
      // requests is claimed. Conditional on state='pending' so it's idempotent
      // under the 10-minute reclaim churn above and across replicas. Distinct
      // job ids only; best-effort (a missing replay_jobs table on an old deploy
      // must never break the claim, which is the live replay path).
      const jobIds = [
        ...new Set(
          result.rows
            .map((r) => r.replay_job_id)
            .filter((id): id is string => id != null),
        ),
      ];
      for (const jobId of jobIds) {
        try {
          await pool.query(
            `UPDATE replay_jobs
                SET state = 'running',
                    started_at = COALESCE(started_at, now())
              WHERE id = $1
                AND state = 'pending'`,
            [jobId],
          );
        } catch (err) {
          console.error(
            `[replay-job] running stamp on claim failed: ${sanitizeConnectorDiagnosticForStorage(
              err instanceof Error ? err.message : err,
            )}`,
          );
        }
      }
      return result.rows;
    },
    /**
     * After the router enqueues delivery messages, we mark the row dispatched.
     * Final `done`/`failed` state is the delivery-service's job — see
     * `markReplayResult` in server.ts which fires when the queue worker
     * observes a delivery for an event_id carrying a replay suffix.
     *
     * We keep `state` at `in_progress` here intentionally: the row only
     * becomes terminal after the dispatched delivery actually completes.
     */
    async markDispatched(_id, _summary): Promise<void> {
      // No-op: row stays `in_progress`. The delivery handler in server.ts
      // transitions to done|failed. We could write a marker column here
      // (e.g. dispatched_at) but the schema doesn't have one and adding it
      // is out of scope for the bug fix.
    },
    async markDone(id, _summary): Promise<void> {
      const result = await pool.query<{ replay_job_id: string | null }>(
        `UPDATE replay_requests
            SET state = 'done',
                finished_at = now()
          WHERE id = $1
        RETURNING replay_job_id`,
        [id],
      );
      // Dispatch-success-but-no-delivery is rare, but markDone is reachable; if
      // the row belongs to a tracked job, advance + finish-once so the job can
      // complete entirely inside this worker without a delivery observation.
      const jobId = result.rows[0]?.replay_job_id;
      if (jobId) await advanceReplayJobOnTerminal(pool, jobId, "succeeded");
    },
    async markFailed(id, message): Promise<void> {
      const safeMessage = sanitizeConnectorDiagnosticForStorage(message, 1000);
      const result = await pool.query<{ replay_job_id: string | null }>(
        `UPDATE replay_requests
            SET state = 'failed',
                finished_at = now(),
                error_message = $2
          WHERE id = $1
        RETURNING replay_job_id`,
        [id, safeMessage],
      );
      // The DISPATCH-failed terminal path: a replay that never enqueued a
      // delivery (R2 payload missing, route deleted, processQueueMessage threw)
      // finishes entirely here — no delivery message ever reaches server.ts's
      // markReplayDeliveryOutcome. Without this advance/finish the job's last
      // in-flight replay would leave it 'running' forever. Best-effort; never
      // breaks the replay batch.
      const jobId = result.rows[0]?.replay_job_id;
      if (jobId) await advanceReplayJobOnTerminal(pool, jobId, "failed");
    },
  };
}

// ---- RouteStore (Postgres) ---- //

/**
 * Backed by the shared `loadActiveRoutes` (route-store.ts) — the SAME loader
 * that feeds `/internal/routes` for the live router-edge worker — so the
 * replay path sees identical route metadata (pipeline_graph, field_selection,
 * destination types + bindings) and makes the same edge/native queue choice.
 */
export function createPgRouteStore(pool: Pool): RouteStore {
  return {
    async listActiveBySource(workspaceId: string, sourceId: string): Promise<RouteWithDestinationTypes[]> {
      return loadActiveRoutes(pool, workspaceId, sourceId);
    },
    async markErrored(routeId, reason, message): Promise<void> {
      // The RouteStore interface carries no workspace id — the route id came
      // from our own fan-out, not the wire, so the unscoped update is safe.
      await markRouteErrored(pool, null, routeId, reason, message);
    },
  };
}

// ---- DeadLetterSink (Postgres) ---- //

export function createPgDeadLetterSink(pool: Pool): DeadLetterSink {
  return {
    async push(record: DeadLetterRecord): Promise<void> {
      const safeMessage = sanitizeConnectorDiagnosticForStorage(record.message, 400);
      // Stamp the same fingerprint the inbox recomputes + bulk replay mutes
      // against. Hash the exact route_id/reason/message we INSERT.
      const fingerprint = await deadLetterFingerprint({
        route_id: record.route_id,
        reason: record.reason,
        message: safeMessage,
      });
      await pool.query(
        `INSERT INTO dead_letters
           (workspace_id, event_id, source_id, route_id, r2_key, reason, message, errored_at, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT DO NOTHING`,
        [
          record.workspace_id,
          record.event_id,
          record.source_id,
          record.route_id,
          record.r2_key,
          record.reason,
          safeMessage,
          record.errored_at,
          fingerprint,
        ],
      );
    },
  };
}

// ---- RawPayloadStore (Cloudflare R2 HTTP API) ---- //

export interface R2HttpDeps {
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  rawPayloadBucket: string;
  fetchImpl?: typeof fetch;
}

export function createR2HttpRawPayloadStore(deps: R2HttpDeps): RawPayloadStore {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async get(key: string): Promise<ArrayBuffer | null> {
      const url = cloudflareR2ObjectUrl(
        deps.cloudflareAccountId,
        deps.rawPayloadBucket,
        key,
      );
      const res = await fetchR2WithRetry(fetchImpl, url, {
        headers: { authorization: `Bearer ${deps.cloudflareApiToken}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`r2_get_${res.status}: ${await errorBodyExcerpt(res)}`);
      }
      return await res.arrayBuffer();
    },
  };
}

/**
 * Cloudflare R2 PUT via the account-scoped HTTP API. Mirrors
 * `createR2HttpRawPayloadStore` but writes instead of reads — used to
 * spill oversized queue messages when the Node replay worker is
 * enqueueing on the Cloudflare Queues HTTP path.
 */
export function createR2HttpSpillStore(deps: R2HttpDeps): QueueSpillWriter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async put(key: string, body: string): Promise<void> {
      const url = cloudflareR2ObjectUrl(
        deps.cloudflareAccountId,
        deps.rawPayloadBucket,
        key,
      );
      const res = await fetchR2WithRetry(fetchImpl, url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.cloudflareApiToken}`,
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`r2_put_${res.status}: ${await errorBodyExcerpt(res)}`);
      }
    },
  };
}

/**
 * R2 PUT surface for the `r2` DESTINATION connector (distinct from queue spill).
 * Same account-scoped HTTP API; shaped as @axel/connectors `ObjectStoreLike` so
 * delivery-service can register an r2 connector. Without it, an r2 message the
 * pull loop wins from the dual-consumer (edge push + Node pull) delivery queue
 * has no connector and is dead-lettered (connector_not_registered:r2) — the
 * delivery permanently lost. Writes to the platform raw bucket, mirroring
 * delivery-edge's EVENTS_RAW binding. Subject metadata is sent best-effort as
 * x-amz-meta-* headers (R2 is S3-compatible); delivery succeeds regardless.
 */
export function createR2HttpObjectStore(deps: R2HttpDeps): ObjectStoreLike {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async put(key: string, value: ArrayBuffer, metadata: Record<string, string>): Promise<void> {
      const url = cloudflareR2ObjectUrl(
        deps.cloudflareAccountId,
        deps.rawPayloadBucket,
        key,
      );
      const metaHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(metadata)) metaHeaders[`x-amz-meta-${k}`] = v;
      const res = await fetchR2WithRetry(fetchImpl, url, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.cloudflareApiToken}`,
          ...metaHeaders,
        },
        body: value,
      });
      if (!res.ok) {
        throw new Error(`r2_put_${res.status}: ${await errorBodyExcerpt(res)}`);
      }
    },
  };
}

/**
 * R2 read+delete surface for the consumer side: hydrate spill objects
 * before delivery and best-effort delete after a terminal outcome.
 * Uses the same account-scoped HTTP API as the reader/writer above.
 */
export function createR2HttpSpillReader(deps: R2HttpDeps): {
  get(key: string): Promise<ArrayBuffer | null>;
  delete(key: string): Promise<void>;
} {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = (key: string) => cloudflareR2ObjectUrl(
    deps.cloudflareAccountId,
    deps.rawPayloadBucket,
    key,
  );
  return {
    async get(key: string): Promise<ArrayBuffer | null> {
      const res = await fetchR2WithRetry(fetchImpl, url(key), {
        headers: { authorization: `Bearer ${deps.cloudflareApiToken}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`r2_get_${res.status}: ${await errorBodyExcerpt(res)}`);
      }
      const declared = contentLength(res);
      const buf = await res.arrayBuffer();
      // A short body means the response stream was cut mid-object. Left alone
      // it reaches JSON.parse and surfaces as an unterminated-string
      // SyntaxError (JAVASCRIPT-3M) that reads like a payload bug rather than
      // the transient read it is. Name it so the caller retries.
      if (declared !== null && buf.byteLength < declared) {
        throw new Error(`r2_get_truncated: ${key} (${buf.byteLength}/${declared} bytes)`);
      }
      return buf;
    },
    async delete(key: string): Promise<void> {
      const res = await fetchR2WithRetry(fetchImpl, url(key), {
        method: "DELETE",
        headers: { authorization: `Bearer ${deps.cloudflareApiToken}` },
      });
      if (!res.ok && res.status !== 404) {
        throw new Error(`r2_delete_${res.status}: ${await errorBodyExcerpt(res)}`);
      }
    },
  };
}

// ---- DeliveryQueueSink (Cloudflare Queues HTTP API) ---- //

export interface CfQueueDeps {
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  deliveryQueueId: string;
  fetchImpl?: typeof fetch;
}

export function createCloudflareDeliveryQueueSink(deps: CfQueueDeps): DeliveryQueueSink {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async enqueue(message): Promise<void> {
      const res = await fetchWithTimeout(
        fetchImpl,
        `https://api.cloudflare.com/client/v4/accounts/${deps.cloudflareAccountId}/queues/${deps.deliveryQueueId}/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${deps.cloudflareApiToken}`,
          },
          body: JSON.stringify({ body: message }),
        },
      );
      if (!res.ok) {
        throw new Error(`queue_enqueue_${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  };
}

// ---- ReplayPayloadHints (ClickHouse `events` lookup) ---- //

export interface ClickhouseHttpDeps {
  url: string;
  user?: string;
  password?: string;
  fetchImpl?: typeof fetch;
}

const CLICKHOUSE_HINTS_MAX_MEMORY_BYTES = 256 * 1024 * 1024;
const CLICKHOUSE_HINTS_MAX_EXECUTION_SECONDS = 5;

export function createClickhousePayloadHints(deps: ClickhouseHttpDeps): ReplayPayloadHints {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async resolveHints(eventId: string, _r2Key: string) {
      // The events table stores headers_json/query_json as String, content_type
      // as LowCardinality(String). We re-hydrate them so the replayed
      // QueueMessage looks as much like the original as possible.
      const url = new URL(deps.url);
      url.searchParams.set("default_format", "JSON");
      url.searchParams.set("param_event_id", eventId);
      url.searchParams.set("max_execution_time", String(CLICKHOUSE_HINTS_MAX_EXECUTION_SECONDS));
      url.searchParams.set("max_memory_usage", String(CLICKHOUSE_HINTS_MAX_MEMORY_BYTES));
      url.searchParams.set("max_threads", "1");
      url.searchParams.set("max_result_rows", "1");
      const sql = `
        SELECT toString(received_at) AS received_at,
               content_type,
               size_bytes,
               shard,
               headers_json,
               query_json,
               is_test
          FROM events
         WHERE event_id = {event_id:String}
         ORDER BY received_at DESC
         LIMIT 1
      `;
      const headers: Record<string, string> = {
        "content-type": "text/plain; charset=UTF-8",
        "X-ClickHouse-User": deps.user ?? "default",
      };
      if (deps.password) headers["X-ClickHouse-Key"] = deps.password;
      const res = await fetchWithTimeout(fetchImpl, url, { method: "POST", body: sql, headers });
      if (!res.ok) return null;
      const text = await res.text();
      if (!text.trim()) return null;
      let json: {
        data?: Array<{
          received_at: string;
          content_type: string;
          size_bytes: number;
          shard: number;
          headers_json: string;
          query_json: string;
          is_test: boolean;
        }>;
      };
      try {
        json = JSON.parse(text) as typeof json;
      } catch {
        return null;
      }
      const row = json.data?.[0];
      if (!row) return null;
      let parsedHeaders: Record<string, string> = {};
      try {
        parsedHeaders = JSON.parse(row.headers_json) as Record<string, string>;
      } catch {
        // tolerate malformed historical rows
      }
      let parsedQuery: Record<string, string> = {};
      try {
        parsedQuery = JSON.parse(row.query_json) as Record<string, string>;
      } catch {
        // tolerate malformed historical rows
      }
      // ClickHouse hands back "2026-05-18 12:34:56.789" — convert to ISO so
      // downstream consumers don't need to know the wire format.
      const receivedAtIso = row.received_at.replace(" ", "T") + "Z";
      return {
        received_at: receivedAtIso,
        content_type: row.content_type,
        size_bytes: row.size_bytes,
        shard: row.shard,
        headers: parsedHeaders,
        query: parsedQuery,
        // Carry the original test-flag forward so replaying a test event
        // stays non-billable. ClickHouse returns is_test as a boolean.
        is_test: row.is_test === true,
      };
    },
  };
}

// ---- Logger ---- //

function createConsoleEventLogger(): EventLogSink {
  return {
    record(event: string, payload: unknown) {
      console.log(`[replay] ${event}`, JSON.stringify(payload));
    },
  };
}

// ---- Wire it up ---- //

export interface ReplayWorkerDeps {
  pool: Pool;
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  rawPayloadBucket: string;
  /** Default queue for replay fan-out; normally axel-delivery for edge-capable destinations. */
  deliveryQueueId: string;
  /** Optional native queue for Postgres/MongoDB/Databricks replay fan-out. */
  nativeDeliveryQueueId?: string;
  clickhouseUrl?: string;
  clickhouseUser?: string;
  clickhousePassword?: string;
  /** Periodic interval. Defaults to 30s — matches the replay processor doc comment. */
  intervalMs?: number;
  /** Max replays claimed per tick. Defaults to 16. */
  batchSize?: number;
  /** Test injection point. */
  fetchImpl?: typeof fetch;
  /** Optional alert sink for periodic-job failures. */
  alertSink?: Parameters<typeof startPeriodicRunner>[1] extends { alertSink?: infer S } ? S : never;
}

export function buildReplayProcessorDeps(deps: ReplayWorkerDeps): ReplayProcessorDeps {
  const nativeDestinationQueue = deps.nativeDeliveryQueueId
    ? createCloudflareDeliveryQueueSink({
        cloudflareAccountId: deps.cloudflareAccountId,
        cloudflareApiToken: deps.cloudflareApiToken,
        deliveryQueueId: deps.nativeDeliveryQueueId,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      })
    : undefined;
  const router: RouterDeps = {
    rawPayloads: createR2HttpRawPayloadStore({
      cloudflareAccountId: deps.cloudflareAccountId,
      cloudflareApiToken: deps.cloudflareApiToken,
      rawPayloadBucket: deps.rawPayloadBucket,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    routes: createPgRouteStore(deps.pool),
    destinationQueue: createCloudflareDeliveryQueueSink({
      cloudflareAccountId: deps.cloudflareAccountId,
      cloudflareApiToken: deps.cloudflareApiToken,
      deliveryQueueId: deps.deliveryQueueId,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    ...(nativeDestinationQueue ? { nativeDestinationQueue } : {}),
    spillStore: createR2HttpSpillStore({
      cloudflareAccountId: deps.cloudflareAccountId,
      cloudflareApiToken: deps.cloudflareApiToken,
      rawPayloadBucket: deps.rawPayloadBucket,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    }),
    deadLetter: createPgDeadLetterSink(deps.pool),
    logger: createConsoleEventLogger(),
  };
  const processorDeps: ReplayProcessorDeps = {
    router,
    replays: createPgReplayStore(deps.pool),
    batchSize: deps.batchSize ?? 16,
  };
  if (deps.clickhouseUrl) {
    processorDeps.hints = createClickhousePayloadHints({
      url: deps.clickhouseUrl,
      ...(deps.clickhouseUser ? { user: deps.clickhouseUser } : {}),
      ...(deps.clickhousePassword ? { password: deps.clickhousePassword } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
  }
  return processorDeps;
}

export function startReplayWorker(deps: ReplayWorkerDeps): RunnerHandle {
  const processorDeps = buildReplayProcessorDeps(deps);
  const intervalMs = deps.intervalMs ?? 30_000;
  return startPeriodicRunner(
    [
      {
        name: "replay_processor",
        intervalMs,
        run: async () => {
          const summaries = await processReplayBatch(processorDeps);
          if (summaries.length > 0) {
            console.log(`[replay] dispatched ${summaries.length} replay(s)`);
          }
        },
      },
    ],
    deps.alertSink ? { alertSink: deps.alertSink } : {},
  );
}
