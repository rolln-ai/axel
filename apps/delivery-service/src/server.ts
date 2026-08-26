/**
 * Axel delivery service — Render-deployed Node service that:
 *   1. Polls Cloudflare Queues (axel-delivery-native) in pull mode for destination messages.
 *   2. Loads destination config from Postgres.
 *   3. Dispatches via the connector registry (HTTP / R2 / Postgres / Mongo / S3 / Databricks).
 *   4. Writes attempt outcome to Postgres delivery_idempotency.
 *   5. Acks (success / dead) or releases (retry) the queue lease.
 *
 * Why Render and not a Cloudflare Worker:
 *   - Native MongoDB and Postgres drivers (mongodb, pg) need Node TCP sockets.
 *   - AWS SDK works in Workers but the integration story is messier.
 *
 * Required env vars:
 *   CLOUDFLARE_ACCOUNT_ID
 *   CLOUDFLARE_API_TOKEN
 *   DELIVERY_QUEUE_ID         — native pull-mode queue id
 *   EDGE_DELIVERY_QUEUE_ID    — optional, replay fan-out queue id for edge-capable destinations
 *   DATABASE_URL              — Postgres control plane
 *   SOURCE_LOOKUP_SHARED_SECRET — dedicated /internal/source auth (required in production)
 *   SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS — optional rotation-only previous credential
 *   POLL_BATCH_SIZE           — optional, default 25
 *   POLL_INTERVAL_MS          — optional, default 1000
 *   MAX_CONCURRENT_DELIVERIES — optional, default 16 (in-flight deliveries per batch)
 *
 * Health check: GET / responds 200 (used by Render).
 */

import http from "node:http";
import dns from "node:dns";
import {
  processDeliveryMessage,
  type AttemptLogSink,
  type CircuitBreaker,
  type CircuitDecision,
  type DestinationResolver,
  type DeliveryWorkerDeps,
  type IdempotencyStore,
  type RetryQueueSink,
} from "@axel/delivery-worker";
import { createConnectorRegistry, createHttpConnector, createR2Connector, createWebhookConnector } from "@axel/connectors";
import {
  controlPlaneDbSslVerify,
  credentialAadString,
  deadLetterFingerprint,
  deleteSpillIfPresent,
  evaluateBreaker,
  hydrateIfSpilled,
  isQueueSpillObjectMissingError,
  mapWithConcurrency,
  numericEnv as sharedNumericEnv,
  scrubConnectorError,
  sleep,
  spillIfOversized,
  type DeliveryAttempt,
  type Destination,
  type DestinationQueueMessage,
  type QueueSpillReader,
  type QueueSpillWriter,
} from "@axel/shared";
import { captureException, captureExceptionBeforeExit, installNodeSentryHandlers, isCloudflareQueueOverloadError, isTransientFetchError, isTransientPlatformHttpError, isTransientPostgresError, isTransientR2Error, recordHeartbeat, sentryClientFromEnv, withPgRetry } from "@axel/observability";
import pg from "pg";
import { buildHttpAuthConfig } from "./auth-headers.js";
import { renderMetrics } from "./metrics.js";
import { startRetentionLoop, type RetentionLoopOptions } from "./retention.js";
import { sweepRawPayloadRetention, createClickhouseR2KeyLister, createR2HttpDeleter } from "./r2-retention.js";
import { createMongoConnector, closeAllMongoClients } from "./connectors/mongodb.js";
import { createPostgresConnector, closeAllPostgresPools } from "./connectors/postgres.js";
import { createS3Connector, closeAllS3Clients, flushAllS3ParquetBatches } from "./connectors/s3.js";
import {
  createDatabricksSqlConnector,
  createDatabricksVolumeConnector,
} from "./connectors/databricks.js";
import { createBigQueryConnector } from "./connectors/bigquery.js";
import { decryptCredentialBlob, loadCredentialsMasterKey } from "./credentials.js";
import { buildAttemptId, logDeliveryAttempt, type ClickhouseLogEnv } from "./clickhouse-log.js";
import { handleCliApi } from "./cli-api.js";
import {
  createR2HttpObjectStore,
  createR2HttpSpillReader,
  createR2HttpSpillStore,
  startReplayWorker,
} from "./replay-worker.js";
import { startBackfillJobWorker } from "./backfill-job-worker.js";
import { startParquetCompactionLoop } from "./parquet-compaction-runner.js";
import { advanceReplayJobOnTerminal } from "./replay-job-completion.js";
import { replayRequestIdFromEventId } from "./replay-event-id.js";
import { alertSinkFromEnv } from "@axel/router";
import { createQueueLagMonitor } from "./queue-lag-monitor.js";
import {
  handleInternalSourceRequest,
  loadInternalSource,
  resolveInternalSourceAuthSecrets,
} from "./internal-source.js";
import {
  loadActiveRoutes,
  markRouteErrored,
  type RouteWithDestinationTypes,
} from "./route-store.js";

const ACCOUNT_ID = requireEnv("CLOUDFLARE_ACCOUNT_ID");
const API_TOKEN = requireEnv("CLOUDFLARE_API_TOKEN");
const QUEUE_ID = requireEnv("DELIVERY_QUEUE_ID");
const EDGE_DELIVERY_QUEUE_ID = process.env.EDGE_DELIVERY_QUEUE_ID;
// Optional dedicated queue for Parquet-S3 deliveries. When set, the worker
// (singleton) role drains it so Parquet batching happens on ONE instance —
// no cross-replica fan-out. Until it's provisioned, router-edge falls back to
// the native queue and the web role delivers Parquet as before.
const PARQUET_QUEUE_ID = process.env.PARQUET_DELIVERY_QUEUE_ID;
const RAW_PAYLOAD_BUCKET = process.env.RAW_PAYLOAD_BUCKET ?? "axel-events-raw";
const DATABASE_URL = requireEnv("DATABASE_URL");

// R2 surfaces for queue-message spill. The producer side (retry sink
// below) writes oversized messages to R2; the consumer side (pull loop
// + /deliver) hydrates them before delivery and best-effort deletes
// the spill key on terminal outcomes.
const spillWriter: QueueSpillWriter = createR2HttpSpillStore({
  cloudflareAccountId: ACCOUNT_ID,
  cloudflareApiToken: API_TOKEN,
  rawPayloadBucket: RAW_PAYLOAD_BUCKET,
});
const spillReader: QueueSpillReader = createR2HttpSpillReader({
  cloudflareAccountId: ACCOUNT_ID,
  cloudflareApiToken: API_TOKEN,
  rawPayloadBucket: RAW_PAYLOAD_BUCKET,
});
// r2 DESTINATION delivery. The native pull loop can still see edge-capable
// messages from replay fallback or manual queue injection, so keep parity with
// delivery-edge by registering the R2 connector here too. Write to the platform
// raw bucket over the same account-scoped HTTP API, matching edge EVENTS_RAW.
const r2ObjectStore = createR2HttpObjectStore({
  cloudflareAccountId: ACCOUNT_ID,
  cloudflareApiToken: API_TOKEN,
  rawPayloadBucket: RAW_PAYLOAD_BUCKET,
});
const BATCH_SIZE = Number(process.env.POLL_BATCH_SIZE ?? "25");
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? "1000");
// Cap concurrent in-flight deliveries within a pulled batch. Without a cap the
// poll loop fanned the whole batch out through one Promise.all, so a large
// batch opened a delivery (credential lookup + idempotency claim + outbound
// socket) per message at once — enough to exhaust the PG pool / hammer a slow
// destination at the platform's target throughput.
const MAX_CONCURRENT_DELIVERIES = Math.max(1, Number(process.env.MAX_CONCURRENT_DELIVERIES ?? "16"));
// Inbound concurrency cap for the authenticated HTTP /deliver escape hatch.
// The normal native path is pull-mode queue processing, bounded by
// maxConcurrentMessages; /deliver remains available for operator tooling or
// emergency direct dispatch and gets a separate cap to protect the pool.
// Defaults to MAX_CONCURRENT_DELIVERIES; override with MAX_DELIVER_INFLIGHT.
const MAX_INFLIGHT_DELIVER = Math.max(
  1,
  Number(process.env.MAX_DELIVER_INFLIGHT ?? String(MAX_CONCURRENT_DELIVERIES)),
);
let inFlightDeliverCount = 0;
// Deployed queue-lag monitor: emits AlertEvents when the oldest message in a
// pulled batch exceeds the threshold. alertSinkFromEnv() returns a no-op sink
// unless ALERT_WEBHOOK_URL is set, so this is safe to wire unconditionally.
const queueLagMonitor = createQueueLagMonitor({ sink: alertSinkFromEnv() });
const PORT = Number(process.env.PORT ?? "10000");

// Service role. "all" (default) runs the HTTP server + delivery poll loop AND
// the singleton background loops (retention/replay/backfill) in one process —
// the single-instance default, unchanged. To scale delivery horizontally, run
// the "web" role (HTTP + poll loop, safe on N instances because CF Queue pull
// leases distribute messages) on a scaled service, and the "worker" role (the
// singletons — must be EXACTLY one instance or backfill/retention duplicate
// and replays can race) on a separate non-scaled service. See render.yaml.
const DELIVERY_ROLE = (process.env.DELIVERY_ROLE ?? "all").toLowerCase();
const runWeb = DELIVERY_ROLE === "all" || DELIVERY_ROLE === "web";
const runWorkers = DELIVERY_ROLE === "all" || DELIVERY_ROLE === "worker";
const PULL_AUTH_ERROR_CAPTURE_INTERVAL_MS = Number(process.env.PULL_AUTH_ERROR_CAPTURE_INTERVAL_MS ?? "900000");
const sentry = sentryClientFromEnv(process.env, "delivery-service");
installNodeSentryHandlers(sentry);

// Deliberately NOT the throwing `requireEnv` from @axel/shared: at boot we
// want a clean one-line `[boot]` log and exit(1), not a stack trace.
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[boot] missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---- Postgres pool (control plane) ---- //
//
// Pool sizing: a 5K-event burst saturated max=8 and PG threw "Connection
// terminated unexpectedly" on ~58% of attempts. With max=20 the worker can
// hold many concurrent in-flight credential lookups + idempotency claims
// without serializing on the pool. Render Postgres free tier allows ~97
// connections; we leave headroom for the dashboard, router-edge, and ad-hoc
// admin work to share the same DB.
//
// Add explicit timeouts so a stuck connection fails loud rather than hanging
// the queue-loop tick. `connectionTimeoutMillis` covers the initial handshake;
// `idleTimeoutMillis` ages out idle connections so PG can recycle them.
//
// `pool.on("error")` is critical — without it, an asynchronous PG error
// (e.g., server-side termination) crashes the entire process. We log and
// move on; the next query gets a fresh connection from the pool.

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? "20", 10),
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: controlPlaneDbSslVerify(process.env.CONTROL_PLANE_DB_SSL_VERIFY) },
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
});

pool.on("error", (err) => {
  console.error("[control-pool] async error (handled):", err instanceof Error ? err.message : err);
  // Suppress per-connection noise during a managed-Postgres pooler restart.
  // A failover fires this listener once per dead connection; capturing each
  // one opens a fresh Sentry fingerprint and buries the real signal
  // (heartbeat / queue lag). Code that actually needed a working pool will
  // re-surface the failure through `withPgRetry`.
  if (isTransientPostgresError(err)) return;
  void captureException(sentry, err, { tags: { component: "postgres_pool" } });
});

/**
 * Wrap a Postgres operation in a one-shot retry on transient errors.
 *
 * The 5K-event burst test surfaced two transient PG errors that aren't the
 * caller's fault:
 *   - `Connection terminated unexpectedly` (server-side TCP reset under load)
 *   - `read ECONNRESET` (network blip)
 *   - `Connection ended unexpectedly` (PG closed mid-query)
 *
 * These are retry-safe in this codepath — credential reads are idempotent
 * and `delivery_idempotency` writes are guarded by a unique key so a
 * duplicate from a retry is a no-op.
 *
 * Permanent errors (syntax, FK violations, auth failures) bubble up
 * immediately so they're not retried wastefully.
 */
// Source of truth lives in @axel/observability/isTransientPostgresError so
// the retry list and the Sentry-suppression list can't drift apart. See
// AXE-95..113 for the incident pattern.

class CloudflareQueueAuthError extends Error {
  constructor(status: number, body: string) {
    super(`[pull] Cloudflare queue auth failed (${status}); check CLOUDFLARE_API_TOKEN permissions: ${body.slice(0, 300)}`);
    this.name = "CloudflareQueueAuthError";
  }
}

// ---- Destination resolver ---- //

interface DestinationRow {
  id: string;
  workspace_id: string;
  type: Destination["type"];
  config: unknown;
  credentials_ref: string | null;
}

// AES-256-GCM master key (same value the dashboard encrypts with). When unset
// the resolver falls through with no merge — only useful for HTTP/R2 dev.
const MASTER_KEY = loadCredentialsMasterKey();
if (!MASTER_KEY) {
  console.warn("[boot] CREDENTIALS_MASTER_KEY not set — destinations with credentials will fail to decrypt");
}

interface CredentialRow {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  encryption_version: number;
  workspace_id: string;
  destination_id: string;
}

async function fetchAndMergeCredentials(
  config: unknown,
  credentialsRef: string | null,
  workspaceId: string,
): Promise<unknown> {
  if (!credentialsRef) return config;
  if (!MASTER_KEY) {
    // Fail closed (matches delivery-edge): a destination WITH a credential ref
    // must be decrypted before delivery. Returning bare config delivered with
    // empty/missing creds and recorded success (audit). Throw so /deliver
    // returns 503 → the router retries until the key is configured.
    throw new Error("credential ref present but CREDENTIALS_MASTER_KEY is not configured");
  }
  // Audit-pass2 — defense in depth: scope the credential lookup by
  // workspace_id even though `destinations.credentials_ref` should
  // never legitimately point at another workspace's credential. If
  // it ever does (bug, manual SQL, future feature), decryption
  // would otherwise succeed and leak the secret.
  const result = await withPgRetry("credential-fetch", () =>
    pool.query<CredentialRow>(
      `SELECT ciphertext, nonce, auth_tag, encryption_version, workspace_id, destination_id
         FROM destination_credentials
        WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [credentialsRef, workspaceId],
    ),
  );
  const row = result.rows[0];
  if (!row) {
    // Fail closed (matches delivery-edge + the MASTER_KEY case above): a
    // destination WITH a credential ref whose row is gone (deleted / rotation
    // race / corruption) must NOT deliver with bare config — that ships an
    // unsigned webhook or a secretless connector and records it as success.
    // Throw so /deliver 503s and the router retries → dead-letters, surfacing
    // the problem instead of silently delivering without credentials.
    console.error(`[delivery] credential row ${credentialsRef} not found for workspace ${workspaceId}`);
    throw new Error(`credential_row_missing: ${credentialsRef} for workspace ${workspaceId}`);
  }
  const aad = Buffer.from(credentialAadString(row.workspace_id, row.destination_id), "utf8");
  const plaintext = await decryptCredentialBlob(MASTER_KEY, row, aad);
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(plaintext) as Record<string, unknown>;
  } catch (err) {
    // Same fail-closed rationale: a credential ref that won't decrypt to JSON
    // can't yield the secrets, so we must not deliver with bare config.
    console.error("[delivery] failed to parse decrypted secrets blob:", err);
    throw new Error("credential_blob_unparseable");
  }
  return { ...(config as Record<string, unknown>), ...secrets };
}

const destinations: DestinationResolver = {
  async getDestination(workspaceId, destinationId) {
    const result = await withPgRetry("destination-fetch", () =>
      pool.query<DestinationRow & { request_timeout_ms: number | null }>(
        `SELECT id, workspace_id, type, config, credentials_ref, request_timeout_ms
           FROM destinations
          WHERE id = $1 AND workspace_id = $2 AND status = 'active'
          LIMIT 1`,
        [destinationId, workspaceId],
      ),
    );
    const row = result.rows[0];
    if (!row) return null;
    const mergedConfig = await fetchAndMergeCredentials(row.config, row.credentials_ref, row.workspace_id);
    // AXE-28 — overlay the destination-level request_timeout_ms into
    // the connector-shaped config. HTTP reads `timeoutMs`; Webhook
    // reads `timeout_ms`. Either field already had a default in the
    // connector — overlay only when the operator set the column.
    let configWithOverlays = mergedConfig;
    if (row.request_timeout_ms !== null && configWithOverlays && typeof configWithOverlays === "object") {
      configWithOverlays = {
        ...(configWithOverlays as Record<string, unknown>),
        timeoutMs: row.request_timeout_ms,
        timeout_ms: row.request_timeout_ms,
      };
    }
    // AXE-33 — materialise auth-mode headers for HTTP destinations
    // so the connector stays a dumb fetch + headers spreader. The
    // wizard collects auth_type + the right secrets; we collapse
    // them to a `headers` dictionary at dispatch time.
    if (row.type === "http" && configWithOverlays && typeof configWithOverlays === "object") {
      configWithOverlays = buildHttpAuthConfig(configWithOverlays as Record<string, unknown>);
    }
    return {
      destination_id: row.id,
      workspace_id: row.workspace_id,
      type: row.type,
      config: configWithOverlays,
      credentials_ref: row.credentials_ref ?? "",
    };
  },
};

// `buildHttpAuthConfig` lives in ./auth-headers.ts (AXE-33 +
// audit-Sev1) so it has a stable unit-test surface for the
// security-critical CR/LF + forbidden-header guards.

// ---- Idempotency store ---- //

const idempotency: IdempotencyStore = {
  async begin(key) {
    // INSERT ... ON CONFLICT lets us atomically claim or detect prior state.
    // Under heavy concurrency (the 580+ DLQ replay storm we saw on
    // 2026-05-14) we'd occasionally get a 23505 *despite* ON CONFLICT
    // — usually because the queue redelivers a message after PG had
    // committed the first INSERT but before the worker observed
    // success, then the retry races a parallel worker on the same
    // key. Catch the SQLSTATE and re-read the existing row instead
    // of bubbling a 503 that ends up dead-lettered.
    interface BeginRow { state: "in_flight" | "completed" | "failed"; inserted: boolean }
    let result: { rows: BeginRow[] };
    // The key is `workspace:event:route:destination` (4 parts), or for a DAG
    // (pipeline-graph) route `workspace:event:route:destination:leaf_node_id`
    // (5 parts) — see @axel/shared idempotencyKeyFor. None of those ids contain a
    // colon (replay event_ids use `#rpy_`), so the first four parts are always the
    // identity. Persist those columns — they were all '' before, which left these
    // rows invisible to GDPR erasure (event_id) + workspace-delete (workspace_id).
    // Require at least the 4 identity parts, else fall back to '' rather than
    // mis-attribute. (delivery-edge already populates these from the message.)
    const parts = key.split(":");
    const [workspaceId, eventId, routeId, destinationId] = parts.length >= 4 ? parts : ["", "", "", ""];
    try {
      result = await withPgRetry("idempotency-begin", () =>
        pool.query<BeginRow>(
          `WITH ins AS (
             INSERT INTO delivery_idempotency
               (idempotency_key, workspace_id, event_id, route_id, destination_id, state, expires_at)
             VALUES ($1, $2, $3, $4, $5, 'in_flight', now() + interval '14 days')
             ON CONFLICT (idempotency_key) DO NOTHING
             RETURNING state, true AS inserted
           )
           SELECT state, inserted FROM ins
           UNION ALL
           SELECT state, false AS inserted FROM delivery_idempotency WHERE idempotency_key = $1
           LIMIT 1`,
          [key, workspaceId, eventId, routeId, destinationId],
        ),
      );
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code === "23505") {
        // PG unique_violation. Treat as "row exists" — re-read state.
        const existing = await withPgRetry("idempotency-begin-recover", () =>
          pool.query<{ state: "in_flight" | "completed" | "failed" }>(
            `SELECT state FROM delivery_idempotency WHERE idempotency_key = $1 LIMIT 1`,
            [key],
          ),
        );
        const state = existing.rows[0]?.state;
        if (state === "completed") return "completed";
        // A "failed" row is a prior attempt that should be retried, not skipped.
        // Returning "completed" here made the worker treat it as already
        // delivered and silently drop the retry under the 23505 race. Return
        // "started" to proceed with delivery (matches the happy-path fallthrough).
        if (state === "failed") return "started";
        return "duplicate";
      }
      throw err;
    }
    const row = result.rows[0];
    if (row?.inserted) return "started";
    const state = row?.state;
    if (state === "completed") return "completed";
    if (state === "in_flight") return "duplicate";
    return "started";
  },
  async complete(key, attempt) {
    await withPgRetry("idempotency-complete", () =>
      pool.query(
        `UPDATE delivery_idempotency
            SET state = 'completed', attempt_id = $2, updated_at = now()
          WHERE idempotency_key = $1`,
        [key, attempt.attempt_id],
      ),
    );
  },
  async fail(key, attempt) {
    await withPgRetry("idempotency-fail", () =>
      pool.query(
        `UPDATE delivery_idempotency
            SET state = 'failed', attempt_id = $2, updated_at = now()
          WHERE idempotency_key = $1`,
        [key, attempt.attempt_id],
      ),
    );
  },
};

// ---- Attempt log + retry sinks ---- //

// The poll loop logs to ClickHouse once per message with the full message
// context (workspace_id, route_id, attempt_no) — none of which are on the
// `DeliveryAttempt` shape that processDeliveryMessage hands to this sink.
// Keeping the sink as a console-only debug hook avoids double-counting in
// ClickHouse without changing the shared AttemptLogSink interface.
const attempts: AttemptLogSink = {
  async recordAttempt(attempt) {
    console.log(
      `[attempt] event=${attempt.event_id} dest=${attempt.destination_id} status=${attempt.status} latency=${attempt.latency_ms}ms`,
    );
  },
};

async function markReplayDeliveryOutcome(
  message: DestinationQueueMessage,
  attempt: DeliveryAttempt,
): Promise<void> {
  const replayId = replayRequestIdFromEventId(message.event_id);
  if (!replayId) return;

  if (attempt.status === "success") {
    // A replay may have been marked failed by stale-row cleanup before the
    // delivery attempt finally reports success. The successful destination
    // outcome is authoritative for dashboard resolution.
    const successUpdate = await withPgRetry("replay-delivery-success", () =>
      pool.query<{ replay_job_id: string | null }>(
        `UPDATE replay_requests
            SET state = 'done',
                finished_at = now(),
                error_message = NULL
          WHERE id = $1
            AND workspace_id = $2
            AND state <> 'done'
        RETURNING replay_job_id`,
        [replayId, message.workspace_id],
      ),
    );
    // Only advance the tracked replay_job when THIS call actually flipped a
    // non-'done' row (an idempotent re-delivery returns rowCount 0 and must
    // not double-count). The authoritative succeeded/failed numbers are
    // recomputed in the finish UPDATE, so the incremental bump is best-effort.
    const successJobRow = successUpdate.rows[0];
    if ((successUpdate.rowCount ?? 0) > 0 && successJobRow?.replay_job_id) {
      await advanceReplayJobOnTerminal(pool, successJobRow.replay_job_id, "succeeded");
    }
    await withPgRetry("replay-dead-letter-resolved", () =>
      pool.query(
        `WITH replay AS (
           SELECT workspace_id, event_id, route_id
             FROM replay_requests
            WHERE id = $1
              AND workspace_id = $2
            LIMIT 1
         )
         UPDATE dead_letters dl
            SET resolved_at = now(),
                resolved_by_replay_id = $1
           FROM replay
          WHERE dl.workspace_id = replay.workspace_id
            AND dl.event_id = replay.event_id
            AND dl.route_id IS NOT DISTINCT FROM replay.route_id
            AND dl.resolved_at IS NULL`,
        [replayId, message.workspace_id],
      ),
    );
    return;
  }

  if (attempt.status === "dead") {
    const failUpdate = await withPgRetry("replay-delivery-failed", () =>
      pool.query<{ replay_job_id: string | null }>(
        `UPDATE replay_requests
            SET state = 'failed',
                finished_at = now(),
                error_message = $3
          WHERE id = $1
            AND workspace_id = $2
            AND state IN ('pending', 'in_progress')
        RETURNING replay_job_id`,
        [replayId, message.workspace_id, deliveryAttemptErrorMessage(attempt)],
      ),
    );
    const failJobRow = failUpdate.rows[0];
    if ((failUpdate.rowCount ?? 0) > 0 && failJobRow?.replay_job_id) {
      await advanceReplayJobOnTerminal(pool, failJobRow.replay_job_id, "failed");
    }
  }
}



function deliveryAttemptErrorMessage(attempt: DeliveryAttempt): string {
  const response = attempt.response;
  if (response && typeof response === "object" && "error" in response) {
    const error = (response as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return "Replay delivery failed.";
}

async function insertDeliveryDeadLetter(
  body: DestinationQueueMessage,
  reason: string,
  message: string,
  erroredAt: string,
): Promise<void> {
  // Scrub value echoes (PG DETAIL, quoted literals, emails, long digit runs)
  // before persisting — dead_letters.message flows into notification rows and
  // Resend alert emails, and DB-connector errors can quote payload values.
  const ddMessage = scrubConnectorError(message).slice(0, 400);
  const fingerprint = await deadLetterFingerprint({ route_id: body.route_id, reason, message: ddMessage });
  await withPgRetry("dead-letter-insert", () =>
    pool.query(
      `INSERT INTO dead_letters
         (workspace_id, event_id, source_id, route_id, destination_id, r2_key, reason, message, errored_at, fingerprint)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT DO NOTHING`,
      [
        body.workspace_id,
        body.event_id,
        body.source_id,
        body.route_id,
        body.destination_id,
        body.r2_key,
        reason,
        ddMessage,
        erroredAt,
        fingerprint,
      ],
    ),
  );
}

// `exactOptionalPropertyTypes` forbids assigning `undefined` to optional fields,
// so we conditionally spread each env var only when it's actually defined.
const clickhouseEnv: ClickhouseLogEnv = {
  ...(process.env.CLICKHOUSE_URL ? { CLICKHOUSE_URL: process.env.CLICKHOUSE_URL } : {}),
  ...(process.env.CLICKHOUSE_USER ? { CLICKHOUSE_USER: process.env.CLICKHOUSE_USER } : {}),
  ...(process.env.CLICKHOUSE_PASSWORD ? { CLICKHOUSE_PASSWORD: process.env.CLICKHOUSE_PASSWORD } : {}),
};
if (!clickhouseEnv.CLICKHOUSE_URL) {
  console.warn("[boot] CLICKHOUSE_URL not set — delivery_attempts will not be logged for the dashboard");
}

const retries: RetryQueueSink = {
  async scheduleRetry(message) {
    // For MVP: re-enqueue immediately with attempt_no incremented. The
    // exponential backoff is handled in the delivery worker before this
    // call. A production implementation would push to axel-delivery-retry
    // with `next_attempt_at` honored.
    //
    // Spill any oversized inline payload back to R2 before posting —
    // both fresh-large messages and previously-spilled ones (which the
    // pull loop hydrated for delivery) need the wire form here, else
    // we'd hit Cloudflare's 128KB cap with `queue_enqueue_413`.
    const wireMessage = await spillIfOversized(message, spillWriter);
    // Honor the backoff the delivery worker already computed
    // (message.next_attempt_at) as the Cloudflare Queues delay_seconds, instead
    // of re-enqueuing immediately. Without this, native-type retries fired at
    // full poll throughput and burned the 12-attempt budget in minutes during an
    // outage, hammering the recovering destination (audit). Capped at the CF max.
    const delaySeconds = message.next_attempt_at
      ? Math.max(0, Math.min(43_200, Math.round((Date.parse(message.next_attempt_at) - Date.now()) / 1000)))
      : 0;
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${QUEUE_ID}/messages`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${API_TOKEN}`,
        },
        body: JSON.stringify({ body: wireMessage, ...(delaySeconds > 0 ? { delay_seconds: delaySeconds } : {}) }),
      },
    );
    if (!res.ok) {
      // MUST throw, not just log: scheduleRetryIfAllowed awaits this, so a throw
      // propagates out of processDeliveryMessage and the poll loop / /deliver land
      // in their catch and RETRY the transport (lease / 503). The double-delivery
      // fix acks the transport on a returned "retry" precisely because a returned
      // "retry" is supposed to GUARANTEE the re-enqueue happened — if we swallowed
      // a non-2xx here, the loop would ack a message whose retry never enqueued
      // (silent loss during a Cloudflare Queues API hiccup, exactly the case this
      // re-enqueue exists to survive).
      const body = await res.text().catch(() => "");
      throw new Error(`retry re-enqueue failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  },
};

async function hydrateRouteDestinationBinding(
  message: DestinationQueueMessage,
): Promise<DestinationQueueMessage> {
  if (message.binding !== null && message.binding !== undefined) return message;
  if (!message.route_id || !message.destination_id) return message;

  const result = await withPgRetry("route-destination-binding", () =>
    pool.query<{ binding: DestinationQueueMessage["binding"] }>(
      `SELECT binding
         FROM route_destinations
        WHERE route_id = $1 AND destination_id = $2
        LIMIT 1`,
      [message.route_id, message.destination_id],
    ),
  );
  const binding = result.rows[0]?.binding ?? null;
  if (binding === null || binding === undefined) return message;
  return { ...message, binding };
}

// ---- Connector registry ---- //

// Resolve all A/AAAA records so the connectors can reject a hostname that
// resolves to a private/metadata IP at delivery time (DNS-rebinding SSRF).
const resolveAllIps = (hostname: string) => dns.promises.lookup(hostname, { all: true });

const connectors = createConnectorRegistry([
  createHttpConnector(globalThis.fetch as typeof fetch, resolveAllIps),
  // Signed-webhook variant. Same wire as HTTP but every request is HMAC-signed
  // and timestamped so the receiver can verify origin + reject replays.
  createWebhookConnector(globalThis.fetch as typeof fetch, resolveAllIps),
  createMongoConnector(),
  createPostgresConnector(),
  createS3Connector(),
  createR2Connector(r2ObjectStore),
  createDatabricksSqlConnector(),
  createDatabricksVolumeConnector(),
  createBigQueryConnector(),
]);

// AXE-27 — Postgres-backed circuit breaker. State lives on the
// destinations row; transitions are audited and write a workspace
// notification so operators see the trip in the in-app inbox.
//
// The decision logic itself is the shared pure `evaluateBreaker`
// (@axel/shared) — the same state machine delivery-edge runs — so the two
// runtimes can never drift again. This side keeps only the SQL: the row
// read, the two atomic conditional transitions the evaluation can ask for
// (open→half_open probe promotion; half_open→open probe-timeout reopen,
// conditional on circuit_half_open_at being unchanged so concurrent workers
// can't race it backwards over a legitimate probe completion), the audit
// trail, and the AXE-28 token-bucket rate limit.
const circuitBreaker: CircuitBreaker = {
  async acquire({ workspaceId, destinationId }) {
    const result = await withPgRetry("circuit-acquire", () =>
      pool.query<{
        circuit_state: "closed" | "open" | "half_open" | "disabled";
        circuit_opened_at: string | null;
        circuit_half_open_at: string | null;
        circuit_cooldown_seconds: number;
        // AXE-28 delivery controls
        delivery_paused: boolean;
        retry_after_until: string | null;
        rate_limit_rps: number | null;
      }>(
        `SELECT circuit_state, circuit_opened_at,
                circuit_half_open_at::text AS circuit_half_open_at,
                circuit_cooldown_seconds,
                delivery_paused, retry_after_until::text AS retry_after_until,
                rate_limit_rps
           FROM destinations
          WHERE id = $1 AND workspace_id = $2
          LIMIT 1`,
        [destinationId, workspaceId],
      ),
    );
    const row = result.rows[0];
    if (!row) return { decision: "deliver" } satisfies CircuitDecision;

    const evaluation = evaluateBreaker(row, Date.now());

    if (evaluation.action === "attempt_half_open_probe") {
      // Cooldown expired — flip to half_open and let this attempt probe.
      // Other concurrent attempts still see `half_open` and are
      // short-circuited to retry (single-probe rule). The winner delivers
      // immediately — the probe takes precedence over the rate-limit cap so
      // the breaker can recover even when rps=1 and the bucket is empty.
      const flipped = await withPgRetry("circuit-flip-half-open", () =>
        pool.query(
          `UPDATE destinations
              SET circuit_state = 'half_open',
                  circuit_half_open_at = now(),
                  -- AXE-audit-Sev2 — reset failure counter at the
                  -- start of the probe window so a single half_open
                  -- failure doesn't immediately re-trip the breaker
                  -- with a counter already above threshold.
                  circuit_consecutive_failures = 0,
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND circuit_state = 'open'`,
          [destinationId, workspaceId],
        ),
      );
      return (flipped.rowCount ?? 0) > 0 ? evaluation.won : evaluation.lost;
    }

    if (evaluation.action === "reopen_timed_out_probe") {
      // AXE-audit-Sev2 followup — the half_open escape valve: a probe that
      // vanished (worker crash, hung connector) would otherwise trap the
      // breaker in half_open forever. Flip back to `open` so the cooldown
      // timer runs again and a fresh probe is eventually promoted.
      const reopened = await withPgRetry("circuit-half-open-reopen", () =>
        pool.query(
          `UPDATE destinations
              SET circuit_state = 'open',
                  circuit_opened_at = now(),
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $2
              AND circuit_state = 'half_open'
              AND (circuit_half_open_at IS NULL
                   OR circuit_half_open_at = $3::timestamptz)`,
          [destinationId, workspaceId, row.circuit_half_open_at],
        ),
      );
      if ((reopened.rowCount ?? 0) > 0) {
        await auditBreakerTransition(
          workspaceId,
          destinationId,
          "half_open",
          "open",
          {
            cause: "half_open_probe_timed_out",
            half_open_at: row.circuit_half_open_at,
            elapsed_ms: evaluation.elapsed_ms,
            cooldown_seconds: row.circuit_cooldown_seconds,
          },
        );
      }
      return evaluation.decision;
    }

    if (evaluation.decision.decision !== "deliver") {
      return evaluation.decision;
    }

    // AXE-audit-Sev2 — circuit state checks ran BEFORE the token
    // bucket consume (an open breaker must not burn rate-limit tokens).
    // AXE-28 — token-bucket rate limit. Atomic UPDATE so concurrent
    // worker instances share the bucket. Returns 0 rows when no
    // tokens are available, otherwise consumes 1.
    //
    // AXE-audit-Sev2 — cold-start bug fix: on the very first
    // attempt `rate_tokens_updated_at` is NULL, which made
    // `EXTRACT(EPOCH FROM (now() - now()))` = 0 and the bucket
    // started at `rate_limit_rps - 1`. When rps=1 the destination
    // was immediately at 0 tokens. Seed `rate_tokens_updated_at`
    // with `now() - 1 second` so the first hit has a full refill
    // window.
    //
    // Audit-pass2 — restored single retry via withPgRetry. The
    // earlier non-retry version traded "double-consume on retry"
    // for "queue redelivery counter increments on every PG
    // hiccup", which under sustained flapping can dead-letter
    // otherwise-deliverable messages. The retry is bounded to one
    // attempt + the UPDATE is idempotent in its WHERE clause
    // (`rate_tokens >= 1`); the worst case of a partially-acked
    // first attempt is one extra token consumed, which is bounded
    // and recovers via the next refill window.
    if (row.rate_limit_rps !== null) {
      const tokenResult = await withPgRetry("rate-token-consume", () =>
        pool.query<{ rate_tokens: number }>(
          `UPDATE destinations
              SET rate_tokens = LEAST(
                    rate_limit_rps::double precision,
                    COALESCE(rate_tokens, rate_limit_rps::double precision) +
                      EXTRACT(EPOCH FROM (now() - COALESCE(rate_tokens_updated_at, now() - interval '1 second')))
                      * rate_limit_rps::double precision
                  ) - 1,
                  rate_tokens_updated_at = now()
            WHERE id = $1
              AND workspace_id = $2
              AND rate_limit_rps IS NOT NULL
              AND LEAST(
                    rate_limit_rps::double precision,
                    COALESCE(rate_tokens, rate_limit_rps::double precision) +
                      EXTRACT(EPOCH FROM (now() - COALESCE(rate_tokens_updated_at, now() - interval '1 second')))
                      * rate_limit_rps::double precision
                  ) >= 1
        RETURNING rate_tokens`,
          [destinationId, workspaceId],
        ),
      );
      if (tokenResult.rowCount === 0) {
        return { decision: "skip_retry", reason: "rate_limited" };
      }
    }
    return { decision: "deliver" };
  },
  async recordOutcome({ workspaceId, destinationId, status, attempt }) {
    // AXE-28 — if the destination sent back a 429 + Retry-After,
    // park the destination for that window so we don't hammer it.
    if (attempt) {
      const resp = attempt.response as
        | { status?: number; retry_after_seconds?: number }
        | null
        | undefined;
      if (
        resp &&
        typeof resp === "object" &&
        resp.status === 429 &&
        typeof resp.retry_after_seconds === "number" &&
        resp.retry_after_seconds > 0
      ) {
        const seconds = Math.min(resp.retry_after_seconds, 3600); // 1h cap
        await withPgRetry("retry-after-write", () =>
          pool.query(
            `UPDATE destinations
                SET retry_after_until = now() + ($3 || ' seconds')::interval,
                    updated_at = now()
              WHERE id = $1 AND workspace_id = $2`,
            [destinationId, workspaceId, String(seconds)],
          ),
        );
      }
    }

    if (status === "success") {
      // Close the breaker. UPDATE is cheap if it's already closed.
      const before = await withPgRetry("circuit-success-read", () =>
        pool.query<{ circuit_state: string }>(
          `SELECT circuit_state FROM destinations WHERE id = $1 AND workspace_id = $2`,
          [destinationId, workspaceId],
        ),
      );
      await withPgRetry("circuit-success-update", () =>
        pool.query(
          `UPDATE destinations
              SET circuit_state = 'closed',
                  circuit_consecutive_failures = 0,
                  circuit_opened_at = NULL,
                  circuit_half_open_at = NULL,
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND circuit_state <> 'disabled'`,
          [destinationId, workspaceId],
        ),
      );
      const previous = before.rows[0]?.circuit_state;
      if (previous && previous !== "closed" && previous !== "disabled") {
        await auditBreakerTransition(workspaceId, destinationId, previous, "closed", {
          reason: "probe_success",
        });
        await resolveBreakerNotification(workspaceId, destinationId);
      }
      return;
    }
    if (status === "dead" || status === "retry") {
      // Increment failure counter. If we cross the threshold (and we
      // aren't already open/disabled), trip.
      const updated = await withPgRetry("circuit-fail-update", () =>
        pool.query<{
          circuit_state: "closed" | "open" | "half_open" | "disabled";
          circuit_consecutive_failures: number;
          circuit_threshold_failures: number;
        }>(
          `UPDATE destinations
              SET circuit_consecutive_failures = circuit_consecutive_failures + 1,
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND circuit_state <> 'disabled'
        RETURNING circuit_state, circuit_consecutive_failures, circuit_threshold_failures`,
          [destinationId, workspaceId],
        ),
      );
      const row = updated.rows[0];
      if (!row) return;
      const shouldOpen =
        row.circuit_state !== "open" &&
        row.circuit_consecutive_failures >= row.circuit_threshold_failures;
      if (!shouldOpen) return;
      const tripped = await withPgRetry("circuit-trip-open", () =>
        pool.query(
          `UPDATE destinations
              SET circuit_state = 'open',
                  circuit_opened_at = now(),
                  circuit_half_open_at = NULL,
                  updated_at = now()
            WHERE id = $1 AND workspace_id = $2 AND circuit_state <> 'open' AND circuit_state <> 'disabled'`,
          [destinationId, workspaceId],
        ),
      );
      if ((tripped.rowCount ?? 0) > 0) {
        await auditBreakerTransition(workspaceId, destinationId, row.circuit_state, "open", {
          reason: "consecutive_failures_threshold",
          consecutive_failures: row.circuit_consecutive_failures,
          threshold: row.circuit_threshold_failures,
        });
        await notifyBreakerOpened(workspaceId, destinationId, row.circuit_consecutive_failures);
      }
    }
  },
};

async function auditBreakerTransition(
  workspaceId: string,
  destinationId: string,
  from: string,
  to: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_log (workspace_id, actor_user_id, action, target_type, target_id, metadata)
       VALUES ($1, NULL, 'destination.circuit_breaker_transition', 'destination', $2, $3)`,
      [workspaceId, destinationId, JSON.stringify({ from, to, ...metadata })],
    );
  } catch (err) {
    console.error("[circuit] audit log write failed", err);
  }
}

async function notifyBreakerOpened(
  workspaceId: string,
  destinationId: string,
  failures: number,
): Promise<void> {
  try {
    // Resolve the destination name so the inbox row reads "Demo BigQuery",
    // not a dst_ id — only the digest used to rewrite it.
    let name = destinationId;
    try {
      const named = await pool.query<{ name: string | null }>(
        `SELECT name FROM destinations WHERE id = $1 AND workspace_id = $2`,
        [destinationId, workspaceId],
      );
      name = named.rows[0]?.name?.trim() || destinationId;
    } catch {
      // Name is cosmetic — fall back to the id.
    }
    // dedup_key + the unread-scoped unique index collapse a flapping
    // destination into ONE unread notification (and one digest mention)
    // instead of a new row — and a new email — per trip.
    // resolveBreakerNotification marks it read on recovery, so the next
    // genuine outage notifies again.
    await pool.query(
      `INSERT INTO notifications (id, workspace_id, user_id, kind, severity, title, body_md, link_path, dedup_key, created_at)
       VALUES ($1, $2, NULL, 'destination_circuit_open', 'warning', $3, $4, $5, $6, now())
       ON CONFLICT DO NOTHING`,
      [
        `notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        workspaceId,
        `Destination paused: ${name}`,
        `Destination \`${name}\` has been temporarily paused after ${failures} consecutive failures. Deliveries will resume automatically after the cooldown.`,
        `/destinations/${destinationId}/controls`,
        `breaker_open:${destinationId}`,
      ],
    );
  } catch (err) {
    // Notifications table may not exist on older deploys yet — log + carry on.
    console.error("[circuit] notification insert failed", err);
  }
}

/**
 * Mark the breaker-open notification read once the breaker closes on a
 * successful delivery. Without this, the unread row (a) keeps reporting an
 * outage that is over, and (b) blocks the dedup slot, so the NEXT real
 * outage could never notify. Best-effort, like the insert.
 */
async function resolveBreakerNotification(
  workspaceId: string,
  destinationId: string,
): Promise<void> {
  try {
    await pool.query(
      `UPDATE notifications
          SET read_at = now()
        WHERE workspace_id = $1
          AND kind = 'destination_circuit_open'
          AND dedup_key = $2
          AND read_at IS NULL`,
      [workspaceId, `breaker_open:${destinationId}`],
    );
  } catch (err) {
    console.error("[circuit] notification resolve failed", err);
  }
}

const deps: DeliveryWorkerDeps = {
  destinations,
  connectors,
  attempts,
  retries,
  idempotency,
  circuitBreaker,
  maxConcurrentMessages: MAX_CONCURRENT_DELIVERIES,
};

// ---- Cloudflare Queues HTTP-pull loop ---- //

interface PulledMessage {
  // Cloudflare's HTTP-pull API returns the body as a JSON STRING when the
  // producer used `contentType: "json"`, even though the docs hint at
  // "parsed object". We parse on receipt so downstream code works with the
  // canonical DestinationQueueMessage shape.
  body: string | DestinationQueueMessage;
  lease_id: string;
  id: string;
  metadata?: { CF_QUEUE_NAME?: string; "CF-Content-Type"?: string };
}

function parseMessageBody(raw: PulledMessage["body"]): DestinationQueueMessage | null {
  if (typeof raw === "string") {
    try {
      return parseMessageBody(JSON.parse(raw) as PulledMessage["body"]);
    } catch (err) {
      console.error("[loop] failed to JSON-parse message body:", err);
      return null;
    }
  }
  if (
    raw
    && typeof raw === "object"
    && "body" in raw
    && Object.keys(raw).length === 1
  ) {
    return parseMessageBody((raw as { body: PulledMessage["body"] }).body);
  }
  return raw as DestinationQueueMessage;
}

async function pullBatch(queueId: string = QUEUE_ID): Promise<PulledMessage[]> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${queueId}/messages/pull`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify({
        batch_size: BATCH_SIZE,
        visibility_timeout_ms: 60_000,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new CloudflareQueueAuthError(res.status, text);
    }
    throw new Error(`[pull] HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { result?: { messages?: PulledMessage[] } };
  return data.result?.messages ?? [];
}

async function ackOrRetry(
  leases: { ack?: string[]; retry?: string[] },
  queueId: string = QUEUE_ID,
): Promise<void> {
  if ((!leases.ack || leases.ack.length === 0) && (!leases.retry || leases.retry.length === 0)) return;
  const body: Record<string, unknown> = {};
  if (leases.ack && leases.ack.length > 0) body.acks = leases.ack.map((id) => ({ lease_id: id }));
  if (leases.retry && leases.retry.length > 0) {
    body.retries = leases.retry.map((id) => ({ lease_id: id, delay_seconds: 30 }));
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${queueId}/messages/ack`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    console.error("[ack] failed:", res.status, await res.text());
  }
}

let stopping = false;
let lastPullAuthCaptureAt = 0;
let pollLoopTickCount = 0;

async function pollLoop(
  queueId: string = QUEUE_ID,
  component: string = "delivery-service",
): Promise<void> {
  while (!stopping) {
    pollLoopTickCount += 1;
    // Heartbeat every tick — last_seen + monotonic counter let the
    // admin/health page tell a frozen loop from a healthy idle one.
    // Best-effort; helper swallows errors.
    void recordHeartbeat(pool, {
      component,
      tickCount: pollLoopTickCount,
      environment: process.env.NODE_ENV ?? "production",
      expectedIntervalSeconds: Math.max(5, Math.ceil(INTERVAL_MS / 1000) * 3),
    });
    try {
      const messages = await pullBatch(queueId);
      if (messages.length === 0) {
        await sleep(INTERVAL_MS);
        continue;
      }

      // Observe queue lag from enqueued_at on the pulled batch (fire-and-forget
      // so alerting never blocks delivery). Best-effort second parse — cheap at
      // batch sizes in the tens.
      void queueLagMonitor
        .observe(
          messages
            .map((m) => parseMessageBody(m.body))
            .filter((b): b is DestinationQueueMessage => b !== null),
        )
        .catch(() => undefined);

      const acks: string[] = [];
      const retries_: string[] = [];

      // Process the batch with bounded concurrency so a large batch can't open
      // an unbounded number of in-flight deliveries and saturate the DB pool or
      // destination. MAX_CONCURRENT_DELIVERIES caps the in-flight work.
      await mapWithConcurrency(
        messages,
        MAX_CONCURRENT_DELIVERIES,
        async (m) => {
          let body = parseMessageBody(m.body);
          if (!body) {
            // Unparseable bodies are terminal — ack so we don't retry forever.
            console.error(`[loop] dropping unparseable message ${m.id}`);
            acks.push(m.lease_id);
            return;
          }
          const startedAt = Date.now();
          body = await hydrateRouteDestinationBinding(body);
          try {
            body = await hydrateIfSpilled(body, spillReader);
          } catch (err) {
            // The hydrate helper throws `spill_r2_key_missing: <key>` so the
            // key path is already in the error message; no need to duplicate
            // it as a Sentry tag.
            console.error(`[loop] spill hydrate failed for ${body.event_id}:`, err);
            if (isQueueSpillObjectMissingError(err)) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              const response = {
                error: errorMessage,
                spill_r2_object: body.spill_r2_key ?? null,
              };
              const attempt: DeliveryAttempt = {
                attempt_id: buildAttemptId(body),
                event_id: body.event_id,
                destination_id: body.destination_id,
                status: "dead",
                response,
                latency_ms: Date.now() - startedAt,
                created_at: new Date().toISOString(),
              };
              void logDeliveryAttempt(clickhouseEnv, {
                workspace_id: body.workspace_id,
                event_id: body.event_id,
                route_id: body.route_id,
                destination_id: body.destination_id,
                attempt_id: attempt.attempt_id,
                attempt_no: body.attempt_no,
                is_test: body.is_test,
                status: "dead",
                latency_ms: attempt.latency_ms,
                response,
                created_at: attempt.created_at,
              });
              try {
                await insertDeliveryDeadLetter(body, "spill_r2_key_missing", errorMessage, attempt.created_at);
              } catch (deadLetterErr) {
                console.error(`[loop] dead_letter insert failed for ${body.event_id}:`, deadLetterErr);
              }
              try {
                await markReplayDeliveryOutcome(body, attempt);
              } catch (replayErr) {
                console.error(`[loop] replay terminal update failed for ${body.event_id}:`, replayErr);
              }
              acks.push(m.lease_id);
              return;
            }
            if (!isTransientR2Error(err) && !isTransientPlatformHttpError(err) && !isTransientFetchError(err)) {
              void captureException(sentry, err, {
                tags: {
                  component: "delivery_poll_loop_spill_hydrate",
                  event_id: body.event_id,
                },
              });
            }
            retries_.push(m.lease_id);
            return;
          }
          let attempt: DeliveryAttempt | null = null;
          try {
            attempt = await processDeliveryMessage(deps, body);
            await markReplayDeliveryOutcome(body, attempt);
          } catch (err) {
            console.error(`[loop] processing failed for ${body.event_id}:`, err);
            if (
              !isTransientR2Error(err) &&
              !isTransientPlatformHttpError(err) &&
              !isTransientFetchError(err)
            ) {
              void captureException(sentry, err, {
                tags: {
                  component: "delivery_poll_loop",
                  event_id: body.event_id,
                  route_id: body.route_id,
                  destination_id: body.destination_id,
                },
              });
            }
            // Log a synthetic retry attempt so the dashboard sees this event
            // attempted (and failing), rather than treating it as silent.
            void logDeliveryAttempt(clickhouseEnv, {
              workspace_id: body.workspace_id,
              event_id: body.event_id,
              route_id: body.route_id,
              destination_id: body.destination_id,
              attempt_id: buildAttemptId(body),
              attempt_no: body.attempt_no,
              is_test: body.is_test,
              status: "retry",
              latency_ms: Date.now() - startedAt,
              response: { error: err instanceof Error ? err.message : String(err) },
              created_at: new Date().toISOString(),
            });
            retries_.push(m.lease_id);
            return;
          }
          // Successful path — log to ClickHouse with full message context.
          // The attempt object only has DeliveryAttempt fields (no workspace/
          // route/attempt_no), so we splice in the message-side context here.
          void logDeliveryAttempt(clickhouseEnv, {
            workspace_id: body.workspace_id,
            event_id: body.event_id,
            route_id: body.route_id,
            destination_id: body.destination_id,
            attempt_id: buildAttemptId(body),
            attempt_no: body.attempt_no,
            is_test: body.is_test,
            status: attempt.status === "success" || attempt.status === "dead" ? attempt.status : "retry",
            latency_ms: attempt.latency_ms,
            response:
              attempt.response && typeof attempt.response === "object"
                ? (attempt.response as Record<string, unknown>)
                : { value: attempt.response },
            created_at: attempt.created_at,
          });
          if (attempt.status === "dead") {
            // Terminal failure — persist a dead_letters row BEFORE acking so the
            // event is visible in the inbox + replayable (audit: the pull loop
            // acked 'dead' with NO dead_letters insert = silent, non-replayable
            // loss across every native delivery). Best-effort (matches the edge):
            // a PG hiccup logs + still acks rather than re-running a dead delivery.
            const r = attempt.response;
            const ddMessage = (
              r && typeof r === "object" && typeof (r as Record<string, unknown>).error === "string"
                ? ((r as Record<string, unknown>).error as string)
                : JSON.stringify(r ?? {})
            );
            try {
              await insertDeliveryDeadLetter(body, "delivery_dead", ddMessage, attempt.created_at);
            } catch (err) {
              console.error(`[loop] dead_letter insert failed for ${body.event_id}:`, err);
            }
          }
          if (attempt.status === "success" || attempt.status === "dead") {
            // Terminal outcome — best-effort delete the spill object so
            // it doesn't leak in R2. Retries keep the spill alive so the
            // next consumer can hydrate.
            await deleteSpillIfPresent(body, spillReader);
            acks.push(m.lease_id);
          } else {
            // status === "retry": processDeliveryMessage ALREADY re-enqueued a
            // fresh attempt_no+1 message (with backoff) via scheduleRetryIfAllowed
            // — the single retry owner that increments attempt_no and enforces
            // max_attempts. ACK the original lease; re-leasing it would make CF
            // ALSO redeliver this exact message (same attempt_no), spawning a
            // second concurrent delivery path: double-POST to the destination,
            // a halved attempt budget, and bypassed backoff. A failed re-enqueue
            // throws and lands in the catch above (lease retried), so a returned
            // "retry" guarantees the re-enqueue succeeded. The spill object is
            // intentionally NOT deleted — the re-enqueued message must hydrate it.
            acks.push(m.lease_id);
          }
        },
      );

      await ackOrRetry({ ack: acks, retry: retries_ }, queueId);
    } catch (err) {
      console.error("[loop] tick error:", err);
      if (err instanceof CloudflareQueueAuthError) {
        const now = Date.now();
        if (now - lastPullAuthCaptureAt >= PULL_AUTH_ERROR_CAPTURE_INTERVAL_MS) {
          lastPullAuthCaptureAt = now;
          void captureException(sentry, err, { tags: { component: "delivery_poll_tick", category: "cloudflare_queue_auth" } });
        }
        await sleep(Math.max(INTERVAL_MS * 10, 30_000));
      } else if (isCloudflareQueueOverloadError(err)) {
        // AXE-65 — pull-API rate-limit. Cloudflare returned 10250
        // (Queue is overloaded). Transient backpressure — back off
        // aggressively but don't spam Sentry; an overloaded queue
        // can keep returning this on every poll for minutes.
        await sleep(Math.max(INTERVAL_MS * 10, 30_000));
      } else if (isTransientFetchError(err)) {
        // AXE-114/115 — Cloudflare Queue pull/ack occasionally fails at
        // the platform fetch layer as plain "TypeError: fetch failed".
        // The poll loop is already retrying forever, so treat this like
        // queue backpressure instead of opening one Sentry issue per blip.
        await sleep(Math.max(INTERVAL_MS * 5, 10_000));
      } else if (isTransientPlatformHttpError(err)) {
        // Cloudflare Queue HTTP API 5xx/504 responses are the same class
        // of transient platform blip as fetch-level failures: the poll loop
        // keeps running and the message remains leased for retry.
        await sleep(Math.max(INTERVAL_MS * 5, 10_000));
      } else {
        void captureException(sentry, err, { tags: { component: "delivery_poll_tick" } });
        await sleep(INTERVAL_MS * 2);
      }
    }
  }
}

// ---- HTTP server: health + /deliver endpoint ----------------------------- //
//
// The /deliver endpoint exists because Cloudflare Queues caps message bodies
// at 128KB. Some sources emit ~244KB events, which means
// the router-edge worker can't enqueue the destination message at all —
// `target.send(...)` throws, the worker retries 3×, the original event lands
// in the auto-DLQ as `max_retries_exceeded` with no useful error.
//
// Resolution: for native-runtime destinations (MongoDB and Databricks today),
// the router HTTP-POSTs the destination message + payload directly to this
// endpoint instead of going through the edge delivery queue. HTTP bodies
// aren't limited to 128KB, so arbitrarily large events flow through cleanly.
// Smaller edge-runtime destinations still use the queue path so we keep the
// queue's at-least-once retry semantics where they help.
//
// Auth: shared secret in `x-axel-shared-secret` header. The router knows it
// via env (set as a Wrangler secret); the delivery service knows it via
// DELIVERY_SHARED_SECRET on Render. Mismatched / missing → 401.

const SHARED_SECRET = process.env.DELIVERY_SHARED_SECRET ?? "";
if (!SHARED_SECRET) {
  console.warn(
    "[boot] DELIVERY_SHARED_SECRET is not set — the /deliver endpoint will reject every request. " +
    "Generate one with `openssl rand -hex 32` and set it on Render and as a router-edge secret.",
  );
}
const SOURCE_LOOKUP_AUTH = resolveInternalSourceAuthSecrets(process.env);
if (runWeb && SOURCE_LOOKUP_AUTH.usingDeliveryFallback) {
  console.warn(
    "[boot] SOURCE_LOOKUP_SHARED_SECRET is not set — /internal/source is temporarily " +
    "using DELIVERY_SHARED_SECRET for bootstrap compatibility",
  );
}

interface DirectDeliverRequest {
  message: DestinationQueueMessage;
}

interface InternalRoutesRequest {
  workspace_id: string;
  source_id: string;
}

interface InternalRoutesResponse {
  routes: Array<
    RouteWithDestinationTypes & {
      /**
       * TRANSITIONAL duplicate of `field_selection` under the legacy camelCase
       * key. Older router-edge deploys read `fieldSelection`; current ones read
       * the canonical snake_case `field_selection` (@axel/shared Route shape).
       * Remove once every router-edge deployment reads `field_selection`.
       */
      fieldSelection: string[] | null;
    }
  >;
}

interface InternalRouteErroredRequest {
  workspace_id: string;
  route_id: string;
  reason: string;
  message: string;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// Cloudflare Workers can't reach Render Postgres directly (Render's network
// blocks CF egress IPs). The router-edge worker calls this endpoint instead
// of running its own SQL — the shared loadActiveRoutes (route-store.ts, also
// used by the replay worker) runs here on the Render side where Postgres is
// reachable, and the wire adds the transitional `fieldSelection` mirror.
async function loadActiveRoutesForWorker(
  workspaceId: string,
  sourceId: string,
): Promise<InternalRoutesResponse["routes"]> {
  const routes = await loadActiveRoutes(pool, workspaceId, sourceId, {
    withRetry: withPgRetry,
  });
  return routes.map((route) => ({
    ...route,
    // Transitional dual-key: see InternalRoutesResponse. Remove with it.
    fieldSelection: route.field_selection ?? null,
  }));
}

const server = http.createServer((req, res) => {
  // Health
  if ((req.method === "GET" || req.method === "HEAD") && (req.url === "/" || req.url === "/health")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "axel-delivery", at: new Date().toISOString() }));
    return;
  }

  // AXE-32 — Prometheus-shaped metrics. Audit-pass2: now gated
  // behind the same `x-axel-shared-secret` header as
  // /internal/routes. `reason` labels can contain operator-shaped
  // text fragments that are competitive intel for a multi-tenant
  // SaaS; gate behind ops-shared-secret so only the customer's
  // own Prometheus scrape (running with the secret set) can read.
  if (req.method === "GET" && req.url === "/metrics") {
    const provided = req.headers["x-axel-shared-secret"];
    if (!SHARED_SECRET || typeof provided !== "string" || provided !== SHARED_SECRET) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end("# unauthorized — set x-axel-shared-secret header\n");
      return;
    }
    void (async () => {
      try {
        const snapshot = await renderMetrics(pool);
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(snapshot.text);
      } catch (err) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`# render_failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    })();
    return;
  }

  // Reliable source lookup for ingest-worker. Cloudflare cannot consistently
  // reach Postgres directly, so delivery-service owns the query + signing-
  // secret decryption and returns the same Source shape used by edge KV. This
  // secret-bearing endpoint uses dedicated source-lookup auth rather than the
  // broader delivery credential once production provisioning is complete.
  if (req.method === "POST" && req.url === "/internal/source") {
    void (async () => {
      const response = await handleInternalSourceRequest(
        {
          providedSecret: req.headers["x-axel-shared-secret"],
          readBody: () => readBody(req),
        },
        {
          sharedSecret: SOURCE_LOOKUP_AUTH.current,
          previousSharedSecret: SOURCE_LOOKUP_AUTH.previous,
          lookupSource: (sourceId) => withPgRetry(
            "internal-source-lookup",
            () => loadInternalSource(pool, sourceId, MASTER_KEY),
          ),
          onError: (err, sourceId) => {
            console.error("[/internal/source] lookup failed:", err);
            if (!isTransientPostgresError(err)) {
              void captureException(sentry, err, {
                tags: {
                  component: "internal_source",
                  ...(sourceId ? { source_id: sourceId } : {}),
                },
              });
            }
          },
        },
      );
      res.writeHead(response.status, response.headers);
      res.end(JSON.stringify(response.body));
    })();
    return;
  }

  // Heartbeat ingress for CF workers (they can't hold a PG
  // connection). Same shared-secret check as /internal/routes;
  // failure to record is best-effort logged but returns 200 so a
  // worker that's the only thing keeping `last_seen` fresh doesn't
  // get stuck retrying on PG transient errors.
  if (req.method === "POST" && req.url === "/internal/heartbeat") {
    void (async () => {
      const provided = req.headers["x-axel-shared-secret"];
      if (!SHARED_SECRET || typeof provided !== "string" || provided !== SHARED_SECRET) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body: {
        component?: string;
        tickCount?: number;
        error?: string;
        metadata?: Record<string, unknown>;
        expectedIntervalSeconds?: number;
        environment?: string;
      };
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `invalid_body: ${err instanceof Error ? err.message : String(err)}` }));
        return;
      }
      if (!body?.component || typeof body.component !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing_component" }));
        return;
      }
      await recordHeartbeat(pool, {
        component: body.component,
        ...(typeof body.tickCount === "number" ? { tickCount: body.tickCount } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
        ...(body.metadata && typeof body.metadata === "object" ? { metadata: body.metadata } : {}),
        ...(typeof body.expectedIntervalSeconds === "number"
          ? { expectedIntervalSeconds: body.expectedIntervalSeconds }
          : {}),
        ...(typeof body.environment === "string" ? { environment: body.environment } : {}),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    })();
    return;
  }

  // Internal route lookup for the edge router (CF<->Render PG path is blocked).
  if (req.method === "POST" && req.url === "/internal/routes") {
    void (async () => {
      const provided = req.headers["x-axel-shared-secret"];
      if (!SHARED_SECRET || typeof provided !== "string" || provided !== SHARED_SECRET) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body: InternalRoutesRequest;
      try {
        body = JSON.parse(await readBody(req)) as InternalRoutesRequest;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `invalid_body: ${err instanceof Error ? err.message : String(err)}` }));
        return;
      }
      if (!body?.workspace_id || !body?.source_id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing_workspace_id_or_source_id" }));
        return;
      }
      try {
        const routes = await loadActiveRoutesForWorker(body.workspace_id, body.source_id);
        const payload: InternalRoutesResponse = { routes };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (err) {
        console.error("[/internal/routes] lookup failed:", err);
        // Skip Sentry on transient pg failures (AXE-95..113) — the router-edge
        // queue redelivery will retry. Same pattern as AXE-65 / AXE-93.
        const transientPostgres = isTransientPostgresError(err);
        if (!transientPostgres) {
          void captureException(sentry, err, {
            tags: { component: "internal_routes", workspace_id: body.workspace_id, source_id: body.source_id },
          });
        }
        res.writeHead(transientPostgres ? 503 : 500, {
          "content-type": "application/json",
          ...(transientPostgres ? { "retry-after": "2" } : {}),
        });
        // Don't echo the raw error to the client (CodeQL js/stack-trace-exposure);
        // the detail is captured to Sentry + logs above.
        res.end(JSON.stringify({ ok: false, error: transientPostgres ? "route_lookup_unavailable" : "internal_error" }));
      }
    })();
    return;
  }

  // Route-error reporting for the edge router. The edge can't reach Render
  // Postgres, so when its declarative engine breaches on a route it POSTs
  // here and we run the same status='errored' UPDATE the replay router's
  // handleBreach path uses — a bad graph now auto-disables the route on live
  // traffic AND replay. Same shared-secret auth as /internal/routes.
  if (req.method === "POST" && req.url === "/internal/routes/errored") {
    void (async () => {
      const provided = req.headers["x-axel-shared-secret"];
      if (!SHARED_SECRET || typeof provided !== "string" || provided !== SHARED_SECRET) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }
      let body: InternalRouteErroredRequest;
      try {
        body = JSON.parse(await readBody(req)) as InternalRouteErroredRequest;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `invalid_body: ${err instanceof Error ? err.message : String(err)}` }));
        return;
      }
      if (!body?.workspace_id || !body?.route_id || !body?.reason) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing_workspace_id_route_id_or_reason" }));
        return;
      }
      try {
        const updated = await withPgRetry("internal-route-errored", () =>
          markRouteErrored(pool, body.workspace_id, body.route_id, body.reason, body.message ?? ""),
        );
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, updated }));
      } catch (err) {
        console.error("[/internal/routes/errored] update failed:", err);
        const transientPostgres = isTransientPostgresError(err);
        if (!transientPostgres) {
          void captureException(sentry, err, {
            tags: { component: "internal_route_errored", workspace_id: body.workspace_id, route_id: body.route_id },
          });
        }
        res.writeHead(transientPostgres ? 503 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: transientPostgres ? "route_errored_unavailable" : "internal_error" }));
      }
    })();
    return;
  }

  // Direct-delivery endpoint
  if (req.method === "POST" && req.url === "/deliver") {
    void (async () => {
      const provided = req.headers["x-axel-shared-secret"];
      if (!SHARED_SECRET || typeof provided !== "string" || provided !== SHARED_SECRET) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
        return;
      }

      let body: DirectDeliverRequest;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw) as DirectDeliverRequest;
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: `invalid_body: ${err instanceof Error ? err.message : String(err)}` }));
        return;
      }

      let message = body?.message;
      if (!message || typeof message !== "object" || !message.event_id || !message.destination_id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "missing_message" }));
        return;
      }
      message = await hydrateRouteDestinationBinding(message);
      try {
        message = await hydrateIfSpilled(message, spillReader);
      } catch (err) {
        console.error(`[/deliver] spill hydrate failed for ${message.event_id}:`, err);
        if (isQueueSpillObjectMissingError(err)) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            ok: true,
            status: "dead",
            latency_ms: 0,
            response: {
              error: "spill_object_missing",
            },
          }));
          return;
        }
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "spill_hydrate_failed" }));
        return;
      }

      // Inbound concurrency gate: bound the heavy delivery work so a
      // native-destination outage can't drive unbounded concurrent Postgres
      // ops into the shared control-plane pool. Over the cap → 503 (the router
      // re-queues). See the 10M/day scaling analysis.
      if (inFlightDeliverCount >= MAX_INFLIGHT_DELIVER) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ ok: false, error: "delivery_overloaded" }));
        return;
      }
      inFlightDeliverCount++;
      const startedAt = Date.now();
      try {
        const attempt = await processDeliveryMessage(deps, message);
        await markReplayDeliveryOutcome(message, attempt);
        if (attempt.status === "success" || attempt.status === "dead") {
          await deleteSpillIfPresent(message, spillReader);
        }
        // Mirror the queue-loop's ClickHouse logging so dashboard sees this.
        void logDeliveryAttempt(clickhouseEnv, {
          workspace_id: message.workspace_id,
          event_id: message.event_id,
          route_id: message.route_id,
          destination_id: message.destination_id,
          attempt_id: buildAttemptId(message),
          attempt_no: message.attempt_no,
          is_test: message.is_test,
          status:
            attempt.status === "success" || attempt.status === "dead" ? attempt.status : "retry",
          latency_ms: attempt.latency_ms,
          response:
            attempt.response && typeof attempt.response === "object"
              ? (attempt.response as Record<string, unknown>)
              : { value: attempt.response },
          created_at: attempt.created_at,
        });

        // A connector "retry" was ALREADY re-enqueued (attempt_no+1, backoff) by
        // processDeliveryMessage via scheduleRetryIfAllowed — the single retry
        // owner. Report it as "rescheduled" so the edge caller ACKs its inbound
        // message instead of retrying it; an edge retry here would redeliver the
        // same message AND coexist with the re-enqueued one — double-delivery.
        // success/dead are terminal. All return 200; a genuine processing failure
        // throws and the catch below returns 503, where the edge correctly retries
        // (no re-enqueue happened in that case).
        const reportedStatus = attempt.status === "retry" ? "rescheduled" : attempt.status;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          ok: true,
          status: reportedStatus,
          latency_ms: attempt.latency_ms,
          response: attempt.response ?? null,
        }));
      } catch (err) {
        console.error(`[/deliver] processing failed for ${message.event_id}:`, err);
        // Transient platform errors (re-enqueue 504, R2 5xx, fetch blips) are
        // retried via the 503 below — don't open a code-bug Sentry issue for
        // them. Mirrors the delivery_poll_loop + spill-hydrate guards (ROL-210).
        if (
          !isTransientR2Error(err) &&
          !isTransientPlatformHttpError(err) &&
          !isTransientFetchError(err)
        ) {
          void captureException(sentry, err, {
            tags: {
              component: "direct_deliver",
              event_id: message.event_id,
              route_id: message.route_id,
              destination_id: message.destination_id,
            },
          });
        }
        // Log the synthetic-retry attempt (same shape as the loop does).
        void logDeliveryAttempt(clickhouseEnv, {
          workspace_id: message.workspace_id,
          event_id: message.event_id,
          route_id: message.route_id,
          destination_id: message.destination_id,
          attempt_id: buildAttemptId(message),
          attempt_no: message.attempt_no,
          is_test: message.is_test,
          status: "retry",
          latency_ms: Date.now() - startedAt,
          response: { error: err instanceof Error ? err.message : String(err) },
          created_at: new Date().toISOString(),
        });
        res.writeHead(503, { "content-type": "application/json" });
        // Generic body — the error detail is logged to ClickHouse + Sentry above.
        res.end(JSON.stringify({ ok: false, error: "internal_error" }));
      } finally {
        inFlightDeliverCount--;
      }
    })();
    return;
  }

  // AXE-26 CLI API surface — `/v1/cli/*`. Authenticated via PAT in
  // the Authorization header. Returns true if it handled the request,
  // false to fall through to the 404 below.
  if (req.url?.startsWith("/v1/cli/")) {
    void (async () => {
      try {
        const handled = await handleCliApi(req, res, {
          pool,
          sentry,
          ingestBaseUrl: process.env.AXEL_INGEST_URL ?? "https://ingest.axelapp.ai",
          ingestAdminToken: process.env.INGEST_ADMIN_TOKEN ?? "",
          cloudflareAccountId: ACCOUNT_ID,
          cloudflareApiToken: API_TOKEN,
          rawPayloadBucket: process.env.RAW_PAYLOAD_BUCKET ?? "axel-events-raw",
          clickhouseUrl: process.env.CLICKHOUSE_URL,
          clickhouseUser: process.env.CLICKHOUSE_USER,
          clickhousePassword: process.env.CLICKHOUSE_PASSWORD,
        });
        if (!handled) {
          res.writeHead(404);
          res.end();
        }
      } catch (err) {
        console.error("[/v1/cli] handler crashed:", err);
        void captureException(sentry, err, { tags: { component: "cli_api" } });
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          // No raw error in the response (console.error + Sentry above hold the detail).
          res.end(JSON.stringify({ error: "internal" }));
        }
      }
    })();
    return;
  }

  res.writeHead(404);
  res.end();
});
if (runWeb) {
  server.listen(PORT, () => {
    console.log(`[boot] axel-delivery listening on :${PORT}`);
  });
} else {
  console.log(`[boot] DELIVERY_ROLE=${DELIVERY_ROLE} — HTTP server + poll loop disabled (worker role)`);
}

// AXE-35 — retention loop. Hourly; logs only when it actually
// deletes anything, so a clean DB stays quiet. Singleton — worker role only.
// When ClickHouse is configured the loop also sweeps R2 raw payloads early for
// workspaces/sources whose effective raw retention is under 30 days (the
// bucket lifecycle rule stays as the ceiling). RAW_RETENTION_MIN_AGE_DAYS is a
// safety floor so an in-flight/retrying delivery can still fetch its body —
// keep it above the Cloudflare Queue message_retention_period.
function buildRetentionLoopOptions(): RetentionLoopOptions {
  const url = clickhouseEnv.CLICKHOUSE_URL;
  if (!url) return {};
  return {
    rawPayloadSweep: () =>
      sweepRawPayloadRetention(pool, {
        lister: createClickhouseR2KeyLister({
          url,
          ...(clickhouseEnv.CLICKHOUSE_USER ? { user: clickhouseEnv.CLICKHOUSE_USER } : {}),
          ...(clickhouseEnv.CLICKHOUSE_PASSWORD ? { password: clickhouseEnv.CLICKHOUSE_PASSWORD } : {}),
        }),
        deleter: createR2HttpDeleter({
          cloudflareAccountId: ACCOUNT_ID,
          cloudflareApiToken: API_TOKEN,
          rawPayloadBucket: RAW_PAYLOAD_BUCKET,
        }),
        minAgeMs: numericEnv("RAW_RETENTION_MIN_AGE_DAYS", 7) * 86_400_000,
      }),
  };
}
const retentionTimer = runWorkers ? startRetentionLoop(pool, buildRetentionLoopOptions()) : null;

function numericEnv(name: string, fallback: number): number {
  return sharedNumericEnv(process.env, name, fallback);
}

// AXE-67 — replay processor. Drains `replay_requests` on a 30s tick.
// Without this loop nothing ever transitions pending → in_progress, so the
// dashboard "Retry" button and the AXE-66 backfill helper silently no-op.
//
// Incident replays can queue tens of thousands of rows. Cap the effective
// drain rate here even if a stale env var is higher; otherwise replay success
// bookkeeping competes with dashboard auth for Postgres connections.
const replayIntervalMs = Math.max(numericEnv("REPLAY_WORKER_INTERVAL_MS", 5_000), 5_000);
const replayBatchSize = Math.min(numericEnv("REPLAY_WORKER_BATCH_SIZE", 50), 50);
const replayWorkerHandle = runWorkers ? startReplayWorker({
  pool,
  cloudflareAccountId: ACCOUNT_ID,
  cloudflareApiToken: API_TOKEN,
  rawPayloadBucket: process.env.RAW_PAYLOAD_BUCKET ?? "axel-events-raw",
  deliveryQueueId: EDGE_DELIVERY_QUEUE_ID ?? QUEUE_ID,
  nativeDeliveryQueueId: QUEUE_ID,
  intervalMs: replayIntervalMs,
  batchSize: replayBatchSize,
  ...(clickhouseEnv.CLICKHOUSE_URL ? { clickhouseUrl: clickhouseEnv.CLICKHOUSE_URL } : {}),
  ...(clickhouseEnv.CLICKHOUSE_USER ? { clickhouseUser: clickhouseEnv.CLICKHOUSE_USER } : {}),
  ...(clickhouseEnv.CLICKHOUSE_PASSWORD ? { clickhousePassword: clickhouseEnv.CLICKHOUSE_PASSWORD } : {}),
}) : null;
if (replayWorkerHandle) {
  console.log(`[boot] replay processor started interval_ms=${replayIntervalMs} batch_size=${replayBatchSize}`);
}

// AXE-66 v2 — backfill job worker. Drains `backfill_jobs` rows by paginating
// ClickHouse and feeding `replay_requests` in throttled chunks. Disabled if
// ClickHouse isn't configured — backfill jobs simply sit in `pending`.
let backfillJobWorkerHandle: { stop(): Promise<void> } | null = null;
if (runWorkers && clickhouseEnv.CLICKHOUSE_URL) {
  backfillJobWorkerHandle = startBackfillJobWorker({
    pool,
    clickhouse: {
      url: clickhouseEnv.CLICKHOUSE_URL,
      ...(clickhouseEnv.CLICKHOUSE_USER ? { user: clickhouseEnv.CLICKHOUSE_USER } : {}),
      ...(clickhouseEnv.CLICKHOUSE_PASSWORD ? { password: clickhouseEnv.CLICKHOUSE_PASSWORD } : {}),
    },
  });
  console.log("[boot] backfill job worker started (60s tick)");
} else {
  console.warn("[boot] CLICKHOUSE_URL not set — backfill job worker disabled");
}

// Parquet compaction — singleton, worker role only, OPT-IN. Merges small
// Parquet objects into large ones (the small-files safety net). Disabled
// unless PARQUET_COMPACTION_ENABLED=1, so deploying this code never touches a
// customer bucket until an operator turns it on. When enabled, deletes happen
// only after a verified PUT (see runCompactionForTarget).
let parquetCompactionHandle: { stop(): Promise<void> } | null = null;
if (runWorkers && (process.env.PARQUET_COMPACTION_ENABLED ?? "") === "1") {
  parquetCompactionHandle = startParquetCompactionLoop({
    pool,
    getDestination: destinations.getDestination,
    intervalMs: Math.max(numericEnv("PARQUET_COMPACTION_INTERVAL_MS", 300_000), 30_000),
    tickOptions: {
      smallFileBytes: numericEnv("PARQUET_COMPACTION_SMALL_FILE_BYTES", 16 * 1024 * 1024),
      minFilesToMerge: 2,
      // Must exceed the delivery flush interval so a just-flushed object is
      // never compacted while a retry might still re-PUT it.
      safetyWindowMs: Math.max(numericEnv("PARQUET_COMPACTION_SAFETY_WINDOW_MS", 120_000), 60_000),
      // Memory-safe default for the 512MB Render starter plan: a many-tiny-files
      // partition with maxInputsPerJob=1000 could open ~1000 input reads in one
      // job. 64 keeps peak per-job memory bounded. Operators with a larger plan
      // can raise it via the env var.
      maxInputsPerJob: Math.max(numericEnv("PARQUET_COMPACTION_MAX_INPUTS_PER_JOB", 64), 2),
    },
  });
  console.log("[boot] parquet compaction loop started");
}


// ---- Graceful shutdown ---- //

async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] received ${signal}, draining...`);
  stopping = true;
  if (retentionTimer) clearInterval(retentionTimer);
  // Stop the periodic runners *before* the pool closes — their in-flight
  // batches still need Postgres to update state. Each stop() awaits the
  // active tick before resolving.
  if (replayWorkerHandle) await replayWorkerHandle.stop();
  if (backfillJobWorkerHandle) await backfillJobWorkerHandle.stop();
  if (parquetCompactionHandle) await parquetCompactionHandle.stop();
  server.close();
  await flushAllS3ParquetBatches();
  await closeAllPostgresPools();
  await closeAllMongoClients();
  closeAllS3Clients();
  await pool.end();
  console.log("[shutdown] done");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ---- Go ---- //

if (runWeb) {
  console.log("[boot] starting poll loop");
  pollLoop().catch(async (err) => {
    console.error("[boot] poll loop crashed:", err);
    await captureExceptionBeforeExit(sentry, err, {
      level: "fatal",
      tags: { component: "delivery_poll_loop" },
    });
    process.exit(1);
  });
} else {
  console.log("[boot] worker role — singleton loops running, no poll loop");
}

// Single-instance Parquet consumer. When a dedicated Parquet queue is
// provisioned, the worker (singleton) role drains it so Parquet batching runs
// on ONE instance — no cross-replica fan-out into many small files. Runs
// alongside the worker's other singleton loops; shares the same connectors +
// deps as the native poll loop.
if (runWorkers && PARQUET_QUEUE_ID) {
  console.log("[boot] starting parquet poll loop (single-instance batching)");
  pollLoop(PARQUET_QUEUE_ID, "delivery-service-parquet").catch(async (err) => {
    console.error("[boot] parquet poll loop crashed:", err);
    await captureExceptionBeforeExit(sentry, err, {
      level: "fatal",
      tags: { component: "delivery_poll_loop_parquet" },
    });
    process.exit(1);
  });
}
