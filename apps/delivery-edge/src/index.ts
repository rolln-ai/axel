/**
 * Axel delivery — Cloudflare Worker that consumes axel-delivery in push mode
 * and dispatches each event to its destination via the appropriate connector.
 *
 * Why a CF Worker (vs. a Render Node service):
 *   - We stay 100% on Cloudflare → simpler deploy, no GitHub-App song and dance.
 *   - Edge-runtime connectors we need work in the Workers runtime:
 *       HTTP   — fetch()
 *       R2     — R2 binding
 *       S3     — aws4fetch (signs S3 REST calls with SigV4)
 *   - Native-runtime connectors (Postgres/MongoDB/Databricks) are routed to
 *     apps/delivery-service via the native queue; this worker only keeps a
 *     forwarding fallback for stale or misrouted messages.
 *
 * What this DOESN'T have (yet, by design):
 *   - Postgres-backed delivery_idempotency claims. The Worker today writes
 *     attempts straight through; replays via the dashboard re-run with a
 *     suffixed event_id so they don't collide.
 *   - Sandbox eval (still owned by future Node router).
 */

import postgres from "postgres";
import { AwsClient } from "aws4fetch";
import {
  controlPlaneDbSslVerify,
  deleteSpillIfPresent,
  hydrateIfSpilled,
  scrubConnectorError,
  type DestinationQueueMessage,
  buildHttpAuthConfig,
  credentialAadString,
  decryptCredentialV2,
  deadLetterFingerprint,
  toArrayBuffer,
  type DeliveryAttempt,
  type Destination,
  type DestinationType,
  type ObjectStoreBinding,
  type PostgresBinding,
  type QueueSpillReader,
  type RouteDestinationBinding,
  evaluateBreaker,
  type CircuitDecision,
  mapInfoSchemaType,
  planColumnRepair,
  planDottedColumnInsert,
  type PgLeafType,
  quotePgIdent,
  quotePgTable,
  splitPgTable,
  validateDestinationUrl,
  isNativeRuntimeDestinationType,
  isParquetObjectStoreBinding,
  postgresJsSslOption,
} from "@axel/shared";
import {
  createHttpConnector,
  createWebhookConnector,
  type FetchLike,
  type HttpDestinationConfig,
  type WebhookDestinationConfig,
} from "@axel/connectors";
import { captureException, isTransientFetchError, isTransientPlatformHttpError, isTransientPostgresError, isTransientR2Error, recordHeartbeatHttp, sentryClientFromEnv, type SentryEnv } from "@axel/observability";
import { logDeliveryAttempt, type ClickhouseLogEnv } from "./clickhouse-log.js";

export interface Env extends ClickhouseLogEnv, SentryEnv {
  // Inbound (push consumer) — wrangler.toml registers axel-delivery as the queue.
  DELIVERY_QUEUE: Queue<DestinationQueueMessage>;
  DEAD_LETTER_QUEUE: Queue<unknown>;
  // R2 binding for r2-type destinations (uses our own bucket — customer R2 buckets
  // would need separate per-destination credentials; not in MVP scope).
  EVENTS_RAW: R2Bucket;
  // Postgres for destination lookup + idempotency.
  DATABASE_URL: string;
  // AES-256-GCM master key for destination credential decryption. 32 bytes
  // hex-encoded (64 hex chars). Same value as on the dashboard (encrypt path)
  // and the Render delivery-service.
  CREDENTIALS_MASTER_KEY?: string;
  // Opt-in TLS cert verification for the control-plane DATABASE_URL connection
  // (set to "true" once Render's CA chain is validated). Default: encrypt-only.
  CONTROL_PLANE_DB_SSL_VERIFY?: string;
  // Same direct-delivery endpoint used by router-edge for native-runtime
  // destinations. This lets delivery-edge recover if an older router deploy,
  // stale queue message, or missing route type map sends a native destination
  // to the edge queue.
  DELIVERY_SERVICE_URL?: string;
  DELIVERY_SHARED_SECRET?: string;
  /** Optional override; defaults to `${DELIVERY_SERVICE_URL}/internal/heartbeat`. */
  DELIVERY_HEARTBEAT_URL?: string;
}

interface DestinationRow {
  id: string;
  workspace_id: string;
  name: string | null;
  type: DestinationType;
  config: unknown;
  credentials_ref: string | null;
  // AXE-27/28 circuit breaker + delivery controls. The edge runs the same
  // shared decision core (@axel/shared evaluateBreaker) as delivery-service,
  // including the open→half_open probe promotion and the half_open timeout
  // reopen, so an edge-only destination's breaker can complete its full
  // open→half_open→closed cycle without delivery-service traffic.
  circuit_state: "closed" | "open" | "half_open" | "disabled";
  circuit_opened_at: string | null;
  circuit_half_open_at: string | null;
  circuit_cooldown_seconds: number;
  delivery_paused: boolean;
  retry_after_until: string | null;
}

export interface CredentialRow {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  auth_tag: Uint8Array;
  encryption_version: number;
  workspace_id: string;
  destination_id: string;
}

function createSql(env: Env): ReturnType<typeof postgres> {
  return postgres(env.DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: env.DATABASE_URL.includes("localhost")
      ? false
      : controlPlaneDbSslVerify(env.CONTROL_PLANE_DB_SSL_VERIFY)
        ? "verify-full"
        : "require",
    // postgres.js prepares statements by default, which breaks under a
    // transaction-mode connection pooler (PgBouncer): "prepared statement does
    // not exist" on a reused server connection. Disabling is harmless
    // direct-to-PG and makes delivery-edge pooler-ready. See scaling analysis.
    prepare: false,
  });
}

function spillReaderFromR2(bucket: R2Bucket): QueueSpillReader {
  return {
    async get(key: string): Promise<ArrayBuffer | null> {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return await obj.arrayBuffer();
    },
    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },
  };
}

// Component heartbeat — delivery-edge is the hottest delivery runtime but was
// absent from /admin/health (EXPECTED_COMPONENTS) and sent no heartbeat, so an
// outage was invisible. Throttled like router-edge so it costs ~one POST/3min.
let lastDeliveryHeartbeatAt = 0;
let deliveryHeartbeatTickCount = 0;
const DELIVERY_HEARTBEAT_THROTTLE_MS = 60_000;

function maybeBeatDelivery(
  env: Env,
  ctx: ExecutionContext,
  error?: string,
  force = false,
): void {
  const url =
    env.DELIVERY_HEARTBEAT_URL ??
    (env.DELIVERY_SERVICE_URL ? `${env.DELIVERY_SERVICE_URL.replace(/\/$/, "")}/internal/heartbeat` : null);
  const secret = env.DELIVERY_SHARED_SECRET;
  if (!url || !secret) return;
  const now = Date.now();
  if (!force && now - lastDeliveryHeartbeatAt < DELIVERY_HEARTBEAT_THROTTLE_MS && !error) return;
  lastDeliveryHeartbeatAt = now;
  deliveryHeartbeatTickCount += 1;
  ctx.waitUntil(
    recordHeartbeatHttp(url, secret, {
      component: "delivery-edge",
      tickCount: deliveryHeartbeatTickCount,
      ...(error ? { error } : {}),
      expectedIntervalSeconds: 180,
      environment: env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? "production",
    }),
  );
}

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // Queue consumers are event-driven: an empty queue means there is no
    // queue() invocation from which to report liveness. A scheduled heartbeat
    // distinguishes a healthy idle worker from a stalled/deleted consumer.
    maybeBeatDelivery(env, ctx, undefined, true);
  },

  async queue(
    batch: MessageBatch<unknown>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const sentry = sentryClientFromEnv(env, "delivery-edge");
    maybeBeatDelivery(env, ctx);
    // This worker is wired to TWO queues:
    //   - axel-delivery       → fan-out delivery to HTTP / R2 / S3 / Postgres
    //   - axel-dead-letter    → record terminal failures into PG dead_letters
    // Cloudflare passes the queue name on `batch.queue`; dispatch on it.
    if (batch.queue === "axel-dead-letter") {
      return drainDeadLetterQueue(batch as MessageBatch<unknown>, env);
    }

    const client = createSql(env);
    const spillReader = spillReaderFromR2(env.EVENTS_RAW);
    try {
      for (const msg of batch.messages as Message<DestinationQueueMessage>[]) {
        const startedAt = Date.now();
        try {
          // Hydrate spilled messages first — router-edge writes the
          // payload/headers/query to R2 when the inline form would
          // exceed Cloudflare's 128KB queue cap. Small messages pass
          // through unchanged.
          const hydrated = await hydrateIfSpilled(msg.body, spillReader);
          const outcome = await deliverOne(hydrated, env, client);
          // Fire-and-forget ClickHouse log. We never block the ack/retry on it
          // — analytics rows missing for a single event is acceptable, queue
          // back-pressure is not.
          ctx.waitUntil(
            logDeliveryAttempt(env, {
              workspace_id: msg.body.workspace_id,
              event_id: msg.body.event_id,
              route_id: msg.body.route_id,
              destination_id: msg.body.destination_id,
              attempt_id: buildAttemptId(msg.body),
              attempt_no: msg.body.attempt_no,
              is_test: msg.body.is_test,
              // "rescheduled" is an edge-internal disposal signal; log the true
              // delivery outcome (a retry) so the dashboard view stays accurate.
              status: outcome.result === "rescheduled" ? "retry" : outcome.result,
              latency_ms: Date.now() - startedAt,
              response: outcome.response,
              created_at: new Date().toISOString(),
            }),
          );
          if (outcome.result === "success" || outcome.result === "dead" || outcome.result === "rescheduled") {
            if (outcome.result === "dead") {
              // Terminal failure — record a dead_letters row so it's visible in
              // the inbox and replayable. Previously the edge ACKed a "dead"
              // outcome with no dead_letters row → silently lost + un-replayable
              // (audit). Awaited (it's a rare path) so the row is durable before
              // ack; a failed insert is logged but still acks (retrying a
              // permanently-dead delivery would loop forever).
              await insertEdgeDeadLetter(client, hydrated, outcome).catch((err) => {
                console.error(`[delivery] dead_letters insert failed for ${hydrated.event_id}:`, err);
              });
            }
            // ACK. For success/dead, delete the spill object so it doesn't linger
            // in R2. For "rescheduled", KEEP it — delivery-service already
            // re-enqueued an attempt_no+1 message that must hydrate the same spill.
            if (outcome.result !== "rescheduled") {
              ctx.waitUntil(deleteSpillIfPresent(hydrated, spillReader));
            }
            msg.ack();
          } else {
            msg.retry(
              outcome.retryDelaySeconds
                ? { delaySeconds: outcome.retryDelaySeconds }
                : undefined,
            );
          }
        } catch (err) {
          console.error("[delivery] dispatch failed", err);
          const finalAttempt = msg.attempts >= DELIVERY_CONSUMER_MAX_RETRIES;
          const transientPlatform =
            isTransientPostgresError(err) ||
            isTransientFetchError(err) ||
            isTransientPlatformHttpError(err) ||
            isTransientR2Error(err);
          if (!transientPlatform || finalAttempt) {
            ctx.waitUntil(captureException(sentry, err, {
              tags: {
                component: "queue_dispatch",
                queue: batch.queue,
                event_id: msg.body.event_id,
                route_id: msg.body.route_id,
                destination_id: msg.body.destination_id,
                final_attempt: finalAttempt,
                ...(transientPlatform ? { category: "transient_platform" } : {}),
              },
            }));
          }
          ctx.waitUntil(
            logDeliveryAttempt(env, {
              workspace_id: msg.body.workspace_id,
              event_id: msg.body.event_id,
              route_id: msg.body.route_id,
              destination_id: msg.body.destination_id,
              attempt_id: buildAttemptId(msg.body),
              attempt_no: msg.body.attempt_no,
              is_test: msg.body.is_test,
              status: "retry",
              latency_ms: Date.now() - startedAt,
              response: { error: err instanceof Error ? err.message : String(err) },
              created_at: new Date().toISOString(),
            }),
          );
          msg.retry();
        }
      }
    } finally {
      ctx.waitUntil(client.end({ timeout: 1 }).catch(() => undefined));
    }
  },
};

const DELIVERY_CONSUMER_MAX_RETRIES = 4;

// "rescheduled" = a forwarded native delivery whose retry the delivery-service
// already re-enqueued (attempt_no+1, backoff). The edge must ACK its inbound
// message for it (not retry) to avoid double-delivery; only forwardNativeDelivery
// produces it. Edge-direct connectors never return it.
type DeliveryResult = "success" | "retry" | "dead" | "rescheduled";

interface DeliveryOutcome {
  result: DeliveryResult;
  response: {
    destination_type?: string;
    http_status?: number;
    error?: string;
  } & Record<string, unknown>;
  /** For breaker/pause skips: how long delivery stays blocked. Passed to
   *  msg.retry({ delaySeconds }) so a known-blocked window doesn't burn the
   *  CF consumer's retry budget (11 retries) in seconds. */
  retryDelaySeconds?: number;
}

/**
 * Deterministic attempt id so the dashboard's event-detail page can group
 * rows even though connectors don't generate one. event+attempt_no is unique
 * per delivery attempt for a given route+destination, which is what we want
 * (replays bump attempt_no, so they get a fresh id).
 */
function buildAttemptId(message: DestinationQueueMessage): string {
  return `${message.event_id}-${message.destination_id}-${message.attempt_no}`;
}

async function deliverOne(
  message: DestinationQueueMessage,
  env: Env,
  client: ReturnType<typeof postgres>,
): Promise<DeliveryOutcome> {
  const dest = await loadDestination(client, message.workspace_id, message.destination_id);
  if (!dest) {
    console.error(`[delivery] unknown destination ${message.destination_id}`);
    return { result: "dead", response: { error: "unknown_destination" } };
  }

  if (isNativeRuntimeDestinationType(dest.type)) {
    return forwardNativeDelivery(message, dest.type, env);
  }

  // Run the shared circuit-breaker state machine for the destinations the
  // edge actually delivers (http/webhook/r2/s3): operator pause, retry-after
  // windows, cooldown gating, probe promotion. A disabled breaker drains to
  // dead-letters; every other skip is a "retry" so holding off can't drop an
  // event.
  const gate = await evaluateEdgeBreaker(client, dest);
  if (gate) return gate;

  // Idempotency claim (audit): CF Queues are at-least-once, so without a claim a
  // worker restart / lost-ack redelivery re-POSTs to http/webhook destinations.
  // CONSERVATIVE: only skip on a CONFIRMED prior completion — a claim-write
  // hiccup falls through to deliver (at-least-once, as before), so this can
  // never DROP a delivery, only suppress a confirmed duplicate.
  let alreadyDelivered = false;
  try {
    alreadyDelivered = (await claimEdgeDelivery(client, message)) === "completed";
  } catch {
    // claim write hiccup → deliver anyway
  }
  if (alreadyDelivered) {
    return { result: "success", response: { destination_type: dest.type, deduped: true } };
  }

  const payloadBytes = encodePayload(message.payload);
  const startedAt = Date.now();
  // Connectors take an ArrayBuffer; the object-store/postgres paths below
  // still take the Uint8Array view. One copy, reused by both http + webhook.
  let payloadBuffer: ArrayBuffer | null = null;
  const asArrayBuffer = (): ArrayBuffer => (payloadBuffer ??= toArrayBuffer(payloadBytes));

  // Merge encrypted credentials (if any) into the destination config so the
  // connectors see one unified object. Decryption happens on every delivery —
  // it's cheap (~1ms with Web Crypto AES-GCM) so we don't bother caching.
  let mergedConfig: unknown;
  try {
    mergedConfig = await mergeCredentialsIntoConfig(client, env, dest);
  } catch (err) {
    console.error(`[delivery] credential decrypt failed for ${dest.id}:`, err);
    return {
      result: "retry",
      response: {
        destination_type: dest.type,
        error: `credential_decrypt_failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  try {
    let result: DeliveryResult;
    let extra: Record<string, unknown> = {};
    switch (dest.type) {
      case "http": {
        // Expand auth_type/bearer/basic/api_key/custom_headers into the headers
        // dict the connector sends — same expansion delivery-service applies.
        // Without this, edge http deliveries to authed endpoints went out with
        // no Authorization header (audit critical).
        const httpConfig = buildHttpAuthConfig(
          mergedConfig as Record<string, unknown>,
        ) as unknown as HttpDestinationConfig;
        const attemptRow = await httpConnector.deliver(
          asArrayBuffer(),
          connectorDestination(dest, httpConfig),
          { eventId: message.event_id, workspaceId: message.workspace_id, routeId: message.route_id },
        );
        result = toDeliveryResult(attemptRow.status);
        extra = edgeResponseExtras(attemptRow.response);
        break;
      }
      case "webhook": {
        const attemptRow = await webhookConnector.deliver(
          asArrayBuffer(),
          connectorDestination(dest, mergedConfig as WebhookDestinationConfig),
          { eventId: message.event_id, workspaceId: message.workspace_id, routeId: message.route_id },
        );
        result = toDeliveryResult(attemptRow.status);
        extra = edgeResponseExtras(attemptRow.response);
        break;
      }
      case "r2":
        result = await deliverR2(env, payloadBytes, mergedConfig as R2Config, message);
        break;
      case "s3":
        result = await deliverS3(payloadBytes, mergedConfig as S3Config, message);
        break;
      default:
        console.error(`[delivery] unsupported type ${dest.type}`);
        result = "dead";
        extra = { error: "unsupported_type" };
        break;
    }
    console.log(
      `[delivery] event=${message.event_id} dest=${message.destination_id} type=${dest.type} status=${result} latency=${Date.now() - startedAt}ms`,
    );
    // Record the claim outcome so a CF redelivery sees "completed" and skips.
    // Best-effort: a mark failure must never flip the delivery result.
    await markEdgeDeliveryClaim(client, message.idempotency_key, result === "success" ? "completed" : "failed").catch(() => {});
    // Record the outcome on the circuit breaker so it auto-trips for edge-native
    // types (http/webhook/r2/s3) — the edge previously only HONORED the breaker
    // but nothing opened it, so the protection was inert (audit). Best-effort.
    await recordEdgeBreakerOutcome(client, dest, result).catch(() => {});
    return { result, response: { destination_type: dest.type, ...extra } };
  } catch (err) {
    const summary = err instanceof Error ? err.message : String(err);
    console.error(`[delivery] event=${message.event_id} dest=${message.destination_id} ERR ${summary}`);
    await recordEdgeBreakerOutcome(client, dest, "retry").catch(() => {});
    return {
      result: "retry",
      response: { destination_type: dest.type, error: summary },
    };
  }
}

/**
 * Take a delivery_idempotency claim for an edge-delivered event. Mirrors the
 * delivery-service begin() but populates the real workspace_id/event_id/route_id
 * (the native path stored empty strings, which broke GDPR/workspace-delete
 * matching). Returns "completed" ONLY when a prior attempt is confirmed
 * complete — every other state proceeds, so this can never drop a delivery.
 */
async function claimEdgeDelivery(
  client: ReturnType<typeof postgres>,
  message: DestinationQueueMessage,
): Promise<"claimed" | "completed"> {
  const rows = await client<{ state: "in_flight" | "completed" | "failed"; inserted: boolean }[]>`
    WITH ins AS (
      INSERT INTO delivery_idempotency
        (idempotency_key, workspace_id, event_id, route_id, destination_id, state, expires_at)
      VALUES (${message.idempotency_key}, ${message.workspace_id}, ${message.event_id},
              ${message.route_id}, ${message.destination_id}, 'in_flight', now() + interval '14 days')
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING state, true AS inserted
    )
    SELECT state, inserted FROM ins
    UNION ALL
    SELECT state, false AS inserted FROM delivery_idempotency WHERE idempotency_key = ${message.idempotency_key}
    LIMIT 1
  `;
  const row = rows[0];
  return row && !row.inserted && row.state === "completed" ? "completed" : "claimed";
}

async function markEdgeDeliveryClaim(
  client: ReturnType<typeof postgres>,
  idempotencyKey: string,
  state: "completed" | "failed",
): Promise<void> {
  await client`UPDATE delivery_idempotency SET state = ${state}, updated_at = now() WHERE idempotency_key = ${idempotencyKey}`;
}

/** Record a terminal "dead" edge delivery into dead_letters (visible + replayable). */
async function insertEdgeDeadLetter(
  client: ReturnType<typeof postgres>,
  message: DestinationQueueMessage,
  outcome: DeliveryOutcome,
): Promise<void> {
  const detail = typeof outcome.response.error === "string"
    ? outcome.response.error
    : JSON.stringify(outcome.response);
  // Build the exact reason/message we store, then fingerprint THOSE so the
  // stamped value matches the inbox recomputation + the bulk-replay mute join.
  const reason = `delivery_dead_${outcome.response.destination_type ?? "unknown"}`;
  // Scrub value echoes (PG DETAIL, quoted literals, emails, long digit runs)
  // before persisting — dead_letters.message surfaces in notification rows and
  // Resend alert emails, and DB-connector errors can quote payload values.
  const storedMessage = scrubConnectorError(detail).slice(0, 400);
  const fingerprint = await deadLetterFingerprint({
    route_id: message.route_id,
    reason,
    message: storedMessage,
  });
  await client`
    INSERT INTO dead_letters
      (workspace_id, event_id, source_id, route_id, destination_id, r2_key, reason, message, errored_at, fingerprint)
    VALUES (
      ${message.workspace_id}, ${message.event_id}, ${message.source_id}, ${message.route_id},
      ${message.destination_id}, ${message.r2_key},
      ${reason}, ${storedMessage}, ${new Date().toISOString()}, ${fingerprint}
    )
    ON CONFLICT DO NOTHING
  `;
}

/**
 * Gate an edge delivery on the destination's breaker/delivery-control state.
 * Returns a "retry"/"dead" outcome when delivery should be held off, or null
 * to proceed. The decision logic is the shared pure `evaluateBreaker`
 * (@axel/shared) — the same state machine delivery-service runs — so the two
 * runtimes can't drift; this side keeps only the postgres.js SQL for the two
 * atomic conditional transitions the evaluation can ask for. The write half
 * (auto trip on the failure threshold, auto reset on success) lives in
 * recordEdgeBreakerOutcome below, so edge-native types (http/webhook/r2/s3)
 * self-heal without delivery-service.
 *
 * Compared to the pre-shared-core edge fork, this ADDS the missing pieces of
 * the state machine: an expired-cooldown probe now atomically flips
 * open→half_open (so concurrent workers single-probe instead of all piling
 * through), and a half_open probe that never resolved reopens after the
 * cooldown instead of trapping the destination forever.
 */
async function evaluateEdgeBreaker(
  client: ReturnType<typeof postgres>,
  dest: DestinationRow,
): Promise<DeliveryOutcome | null> {
  const evaluation = evaluateBreaker(dest, Date.now());

  if (evaluation.action === "attempt_half_open_probe") {
    // Cooldown expired — try to claim the single probe slot (mirrors the
    // delivery-service UPDATE, including the failure-counter reset so one
    // half_open failure can't re-trip with a counter already at threshold).
    const flipped = await client<{ id: string }[]>`
      UPDATE destinations
         SET circuit_state = 'half_open',
             circuit_half_open_at = now(),
             circuit_consecutive_failures = 0,
             updated_at = now()
       WHERE id = ${dest.id} AND workspace_id = ${dest.workspace_id} AND circuit_state = 'open'
      RETURNING id
    `;
    if (flipped.length > 0) return null; // we are the probe — deliver
    return breakerSkipOutcome(dest, evaluation.lost);
  }

  if (evaluation.action === "reopen_timed_out_probe") {
    // The probe vanished (worker crash, hung connector) — flip back to open,
    // conditional on circuit_half_open_at being unchanged so we can't race
    // backwards over a legitimate probe completion. Winner audits, mirroring
    // delivery-service's auditBreakerTransition.
    const reopened = await client<{ id: string }[]>`
      UPDATE destinations
         SET circuit_state = 'open',
             circuit_opened_at = now(),
             updated_at = now()
       WHERE id = ${dest.id} AND workspace_id = ${dest.workspace_id}
         AND circuit_state = 'half_open'
         AND (circuit_half_open_at IS NULL
              OR circuit_half_open_at = ${dest.circuit_half_open_at}::timestamptz)
      RETURNING id
    `;
    if (reopened.length > 0) {
      await client`
        INSERT INTO audit_log (workspace_id, actor_user_id, action, target_type, target_id, metadata)
        VALUES (${dest.workspace_id}, NULL, 'destination.circuit_breaker_transition', 'destination', ${dest.id},
                ${JSON.stringify({
                  from: "half_open",
                  to: "open",
                  cause: "half_open_probe_timed_out",
                  half_open_at: dest.circuit_half_open_at,
                  elapsed_ms: evaluation.elapsed_ms,
                  cooldown_seconds: dest.circuit_cooldown_seconds,
                })})
      `.catch((err) => {
        console.error(`[delivery] breaker audit insert failed for ${dest.id}:`, err);
      });
    }
    return breakerSkipOutcome(dest, evaluation.decision);
  }

  if (evaluation.decision.decision === "deliver") return null;
  return breakerSkipOutcome(dest, evaluation.decision);
}

/** Map a shared CircuitDecision onto the edge's queue-outcome shape. */
function breakerSkipOutcome(
  dest: DestinationRow,
  decision: Exclude<CircuitDecision, { decision: "deliver" }>,
): DeliveryOutcome {
  if (decision.decision === "skip_dead") {
    // Operator hard-disabled this destination — drain the backlog to
    // dead-letters rather than deliver (matches delivery-service skip_dead).
    return { result: "dead", response: { destination_type: dest.type, skipped: decision.reason } };
  }
  return {
    result: "retry",
    response: { destination_type: dest.type, skipped: decision.reason },
    // Clamp to CF Queues' 12h max delay, 1s floor.
    retryDelaySeconds: Math.min(
      43_200,
      Math.max(1, Math.ceil((decision.retry_after_ms ?? 1000) / 1000)),
    ),
  };
}

/**
 * Record a delivery outcome on the destination's circuit breaker so it
 * AUTO-TRIPS for edge-native types (http/webhook/r2/s3) — mirrors
 * delivery-service recordOutcome. On failure, bump the consecutive-failure
 * counter and open the breaker once it crosses the threshold; on success, reset
 * (only when not already closed, so the steady-state success path adds no
 * write). Never touches a 'disabled' breaker. Best-effort: the caller swallows
 * errors so a breaker-write hiccup can't flip the delivery result.
 */
async function recordEdgeBreakerOutcome(
  client: ReturnType<typeof postgres>,
  dest: DestinationRow,
  result: DeliveryResult,
): Promise<void> {
  if (dest.circuit_state === "disabled") return;
  if (result === "success") {
    // Reset only when the loaded state wasn't already closed — avoids a write
    // per successful delivery in the steady state.
    if (dest.circuit_state && dest.circuit_state !== "closed") {
      await client`
        UPDATE destinations
           SET circuit_state = 'closed', circuit_consecutive_failures = 0,
               circuit_opened_at = NULL, circuit_half_open_at = NULL
         WHERE id = ${dest.id} AND workspace_id = ${dest.workspace_id} AND circuit_state <> 'disabled'
      `;
      // Recovery resolves the breaker-open inbox row (mirrors
      // delivery-service). Frees the dedup slot for the next real outage.
      await client`
        UPDATE notifications
           SET read_at = now()
         WHERE workspace_id = ${dest.workspace_id}
           AND kind = 'destination_circuit_open'
           AND dedup_key = ${`breaker_open:${dest.id}`}
           AND read_at IS NULL
      `.catch(() => {});
    }
    return;
  }
  // Failure (retry | dead): bump the counter, then trip if we crossed the
  // threshold and aren't already open. Two statements like delivery-service.
  const bumped = await client<{
    circuit_state: string;
    circuit_consecutive_failures: number;
    circuit_threshold_failures: number;
  }[]>`
    UPDATE destinations
       SET circuit_consecutive_failures = circuit_consecutive_failures + 1
     WHERE id = ${dest.id} AND workspace_id = ${dest.workspace_id} AND circuit_state <> 'disabled'
    RETURNING circuit_state, circuit_consecutive_failures, circuit_threshold_failures
  `;
  const row = bumped[0];
  if (row && row.circuit_state !== "open" && row.circuit_consecutive_failures >= row.circuit_threshold_failures) {
    const opened = await client`
      UPDATE destinations
         SET circuit_state = 'open', circuit_opened_at = now(), circuit_half_open_at = NULL
       WHERE id = ${dest.id} AND workspace_id = ${dest.workspace_id}
         AND circuit_state <> 'open' AND circuit_state <> 'disabled'
      RETURNING id
    `;
    if (opened.length > 0) {
      // The edge used to trip silently — only delivery-service trips reached
      // the inbox/digest, so an http/webhook destination could pause with no
      // alert at all. Same copy + dedup semantics as notifyBreakerOpened.
      const name = dest.name?.trim() || dest.id;
      await client`
        INSERT INTO notifications (id, workspace_id, user_id, kind, severity, title, body_md, link_path, dedup_key, created_at)
        VALUES (
          ${`notif_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`},
          ${dest.workspace_id}, NULL, 'destination_circuit_open', 'warning',
          ${`Destination paused: ${name}`},
          ${`Destination \`${name}\` has been temporarily paused after ${row.circuit_consecutive_failures} consecutive failures. Deliveries will resume automatically after the cooldown.`},
          ${`/destinations/${dest.id}/controls`},
          ${`breaker_open:${dest.id}`},
          now()
        )
        ON CONFLICT DO NOTHING
      `.catch((err) => {
        console.error(`[delivery] breaker notification insert failed for ${dest.id}:`, err);
      });
    }
  }
}

async function forwardNativeDelivery(
  message: DestinationQueueMessage,
  destinationType: DestinationType,
  env: Env,
): Promise<DeliveryOutcome> {
  if (!env.DELIVERY_SERVICE_URL || !env.DELIVERY_SHARED_SECRET) {
    console.error(
      `[delivery] native destination ${message.destination_id} type=${destinationType} reached delivery-edge, ` +
      "but DELIVERY_SERVICE_URL or DELIVERY_SHARED_SECRET is not configured",
    );
    // Misconfiguration is transient — a missing DELIVERY_SERVICE_URL/SHARED_SECRET
    // is fixed by provisioning the secret, not by the producer re-sending.
    // Retry (don't dead-letter) so events aren't permanently lost while the
    // worker is mis-wired (audit).
    return {
      result: "retry",
      response: {
        destination_type: destinationType,
        error: "native_delivery_unconfigured",
      },
    };
  }

  const res = await fetch(`${env.DELIVERY_SERVICE_URL.replace(/\/$/, "")}/deliver`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-axel-shared-secret": env.DELIVERY_SHARED_SECRET,
    },
    body: JSON.stringify({ message }),
  });
  const body = await res.json().catch(() => null) as
    | { status?: DeliveryResult; response?: Record<string, unknown> | null; error?: string }
    | null;
  const response = {
    destination_type: destinationType,
    forwarded_to_native: true,
    native_http_status: res.status,
    ...(body?.response && typeof body.response === "object" ? body.response : {}),
    ...(body?.error ? { error: body.error } : {}),
  };

  if (body?.status === "rescheduled") {
    // delivery-service already re-enqueued the retry (attempt_no+1, backoff).
    // Ack our inbound message; retrying it would double-deliver.
    return { result: "rescheduled", response };
  }
  if (res.status === 503 || body?.status === "retry") {
    return { result: "retry", response };
  }
  if (!res.ok) {
    // A non-2xx from OUR delivery-service is OPERATIONAL — 401 (shared-secret
    // mismatch during rotation), 500 (handler error), 502 (deploy window) — NOT a
    // terminal delivery decision (those arrive as HTTP 200 + body.status="dead",
    // handled below). Honor an explicit terminal signal if the body carries one,
    // otherwise RETRY: a secret rotation must not permanently dead-letter every
    // in-flight native (postgres/mongodb/databricks) delivery for the window.
    if (body?.status === "dead") {
      return { result: "dead", response };
    }
    return { result: "retry", response: { ...response, error: response.error ?? `native_delivery_${res.status}` } };
  }
  return {
    result: body?.status === "dead" ? "dead" : "success",
    response,
  };
}

async function loadDestination(
  client: ReturnType<typeof postgres>,
  workspaceId: string,
  destinationId: string,
): Promise<DestinationRow | null> {
  const rows = await client<DestinationRow[]>`
    SELECT id, workspace_id, name, type, config, credentials_ref,
           circuit_state,
           circuit_opened_at::text AS circuit_opened_at,
           circuit_half_open_at::text AS circuit_half_open_at,
           circuit_cooldown_seconds,
           delivery_paused,
           retry_after_until::text AS retry_after_until
      FROM destinations
     WHERE id = ${destinationId} AND workspace_id = ${workspaceId} AND status = 'active'
     LIMIT 1
  `;
  return rows[0] ?? null;
}

/**
 * Look up the encrypted credential blob for a destination, decrypt it with
 * the master key, and merge the JSON-decoded secrets back into the config
 * object. The connectors then see one merged object containing both
 * non-secret config values (table name, region, …) and the secret fields
 * (connection_string, access_key_id, …) the dashboard captured.
 *
 * Returns the (possibly merged) config. If the destination has no credential
 * row OR the master key isn't configured, returns the original config
 * unchanged so HTTP/R2 destinations work in dev without master-key setup.
 */
async function mergeCredentialsIntoConfig(
  client: ReturnType<typeof postgres>,
  env: Env,
  destination: DestinationRow,
): Promise<unknown> {
  if (!destination.credentials_ref) return destination.config;
  if (!env.CREDENTIALS_MASTER_KEY) {
    // A destination WITH a credential ref must be decrypted before delivery.
    // Returning the bare config here would deliver a webhook unsigned or S3
    // with empty creds and then record it as success — silent bad delivery.
    // Throw so deliverOne maps it to "retry" until the key is configured.
    throw new Error(`dest=${destination.id} requires a credential but CREDENTIALS_MASTER_KEY isn't set`);
  }
  const rows = await client<CredentialRow[]>`
    SELECT ciphertext, nonce, auth_tag, encryption_version, workspace_id, destination_id
      FROM destination_credentials
     WHERE id = ${destination.credentials_ref}
     LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    // Credential ref points at a missing row — same hazard as a missing key.
    // Retry rather than deliver without the secret.
    throw new Error(`credential row ${destination.credentials_ref} missing for dest=${destination.id}`);
  }
  const plaintext = await decryptCredentialBlob(env.CREDENTIALS_MASTER_KEY, row);
  let secrets: Record<string, unknown>;
  try {
    secrets = JSON.parse(plaintext) as Record<string, unknown>;
  } catch (err) {
    // Corrupt/undecryptable secret blob — retry rather than deliver without it.
    throw new Error(
      `failed to parse decrypted secrets for dest=${destination.id}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { ...(destination.config as Record<string, unknown>), ...secrets };
}

/**
 * Decrypt a destination-credential row via the shared AES-256-GCM core
 * (@axel/shared credential-crypto — golden-vector pinned). The v2 AAD is
 * rebuilt from the row's own (workspace, destination) identity.
 *
 * Key parsing stays LOCAL and deliberately laxer than the Node runtimes'
 * strict 64-hex check (any even-length string of the right byte count is
 * accepted; a malformed key then simply fails GCM auth) — preserved exactly
 * so no key form this runtime accepted before is rejected now.
 */
export async function decryptCredentialBlob(masterKeyHex: string, row: CredentialRow): Promise<string> {
  const keyBytes = hexToBytes(masterKeyHex);
  if (keyBytes.length !== 32) {
    throw new Error("CREDENTIALS_MASTER_KEY must be 32 bytes (64 hex chars)");
  }
  return decryptCredentialV2(row, keyBytes, credentialAadString(row.workspace_id, row.destination_id));
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("hex string must have even length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function encodePayload(payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) return payload;
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  return new TextEncoder().encode(JSON.stringify(payload));
}

// ---- HTTP + signed webhook (shared with the Node runtime) ---------------- //
//
// Both request/response destination types are delivered by @axel/connectors —
// the SAME module apps/delivery-service drives. The Worker used to carry a
// hand-port of each (`deliverHttp` / `deliverWebhook`); they had drifted from
// the Node originals on retry classification, response capture and
// Retry-After handling. Everything that legitimately differs between the two
// runtimes is now an explicit parameter:
//
//   - fetch impl  — injected (the Worker's Web-standard global; the Node
//                   service passes its own so undici Agent/keep-alive tuning
//                   stays on that side).
//   - DNS lookup  — NOT passed here: Workers have no DNS resolver API, so the
//                   resolved-IP SSRF (DNS-rebinding) check is Node-only. The
//                   string-level `validateDestinationUrl` gate runs in both.
//   - default timeout — 15s here, unset on Node (see below).
//
// Everything else — URL/method/header construction, HMAC-SHA256/512 signing
// over `<ts>.<body>`, the X-Axel-* header trio, reserved-header shadowing and
// RFC 7230 header filtering, and the 2xx/408/429/4xx/else classification — is
// one implementation, pinned by the golden-request contract test in
// packages/connectors/test/golden-requests.test.ts.

// Wall-clock cap for a single outbound delivery to a customer-controlled URL.
// Without it a slow/hung endpoint pins a delivery slot indefinitely. On
// timeout the connector's AbortController fires and the connector maps the
// resulting abort to a "retry" outcome — so a slow endpoint is retried, not
// left hanging. Worker-specific: a Worker invocation has a hard wall-clock
// budget, whereas the Node poll loop relies on its queue lease instead.
const OUTBOUND_DELIVERY_TIMEOUT_MS = 15_000;

// Deliberately a thin wrapper rather than a captured `globalThis.fetch`
// reference: the Worker's global is what tests spy on, and capturing it at
// module-init would freeze the pre-spy binding.
const edgeFetch: FetchLike = (url, init) =>
  fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;

const httpConnector = createHttpConnector(edgeFetch, undefined, {
  defaultTimeoutMs: OUTBOUND_DELIVERY_TIMEOUT_MS,
});
const webhookConnector = createWebhookConnector(edgeFetch, undefined, {
  defaultTimeoutMs: OUTBOUND_DELIVERY_TIMEOUT_MS,
});

/**
 * Narrow a connector `DeliveryAttempt.status` to the Worker's disposal
 * vocabulary. Connectors only ever emit success/retry/dead; "pending" exists
 * on the shared union for stored rows and would be a bug here, so it maps to
 * the safe (never-drops-an-event) "retry".
 */
function toDeliveryResult(status: DeliveryAttempt["status"]): DeliveryResult {
  return status === "success" || status === "dead" ? status : "retry";
}

/**
 * Project a connector response blob onto the compact shape this Worker writes
 * to ClickHouse `delivery_attempts.response_json`.
 *
 * Two deliberate differences from the raw connector response are preserved
 * here rather than in the connector, so the shared code stays single-form:
 *   - `status` is renamed to `http_status` (what the dashboard reads, and
 *     what edge rows have always carried).
 *   - `body` is DROPPED. Per this Worker's clickhouse-log contract we do not
 *     persist destination response bodies: arbitrary size, may echo customer
 *     secrets, and the dashboard doesn't render them.
 */
function edgeResponseExtras(response: unknown): Record<string, unknown> {
  if (!response || typeof response !== "object") return {};
  const r = response as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof r.status === "number") out.http_status = r.status;
  if (typeof r.error === "string") out.error = r.error;
  if (typeof r.retry_after_seconds === "number") out.retry_after_seconds = r.retry_after_seconds;
  if (typeof r.signed === "boolean") out.signed = r.signed;
  return out;
}

/** Adapt a `DestinationRow` to the connector-facing `Destination` shape. */
function connectorDestination<TConfig>(dest: DestinationRow, config: TConfig): Destination<TConfig> {
  return {
    destination_id: dest.id,
    workspace_id: dest.workspace_id,
    type: dest.type,
    config,
    credentials_ref: dest.credentials_ref ?? "",
  };
}

// ---- R2 ----------------------------------------------------------------- //

interface R2Config {
  bucket: string;
  key_prefix?: string;
}

async function deliverR2(
  env: Env,
  payload: Uint8Array,
  config: R2Config,
  message: DestinationQueueMessage,
): Promise<DeliveryResult> {
  // For MVP, all R2 writes go to our own bucket. Per-destination R2 buckets
  // would require dynamic R2 bindings (not currently possible in CF Workers).
  // Route-level binding (`message.binding.key_prefix`) takes precedence over
  // `destinations.config.key_prefix` — migration 0022 moved per-route target
  // onto `route_destinations.binding`.
  const binding = pickObjectStoreBinding(message.binding);
  const rawPrefix = binding?.key_prefix ?? config.key_prefix ?? "deliveries";
  const prefix = rawPrefix ? `${stripTrailingSlashes(rawPrefix)}/` : "";
  const key = `${prefix}${message.workspace_id}/${new Date().toISOString().slice(0, 10)}/${message.event_id}-${message.destination_id}.json`;
  await env.EVENTS_RAW.put(key, payload, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      event_id: message.event_id,
      workspace_id: message.workspace_id,
      destination_id: message.destination_id,
    },
  });
  return "success";
}

// ---- S3 ----------------------------------------------------------------- //

interface S3Config {
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  key_prefix?: string;
  key_template?: string;
  endpoint?: string;
  addressing_style?: "path" | "virtual_hosted";
}

async function deliverS3(
  payload: Uint8Array,
  config: S3Config,
  message: DestinationQueueMessage,
): Promise<DeliveryResult> {
  const aws = new AwsClient({
    accessKeyId: config.access_key_id,
    secretAccessKey: config.secret_access_key,
    service: "s3",
    region: config.region,
  });
  const binding = pickObjectStoreBinding(message.binding);
  // The edge can only write raw JSON objects. Parquet-S3 is routed to the
  // delivery-service (DELIVERY_PARQUET_QUEUE / native queue) which owns the
  // Parquet writer. If a parquet-bound message still reaches the edge (a stale
  // router isolate from before that routing shipped, or a misprovisioned queue),
  // writing JSON here would silently corrupt the customer's data lake. Refuse
  // and dead-letter (visible + replayable once routing is corrected) rather than
  // write the wrong format and report success.
  if (isParquetObjectStoreBinding(message.binding)) {
    console.error(
      `[delivery] parquet-format S3 message reached the edge (dest=${message.destination_id}, event=${message.event_id}); ` +
      "refusing to write JSON — route parquet-S3 through delivery-service",
    );
    return "dead";
  }
  const date = new Date().toISOString().slice(0, 10);
  const tmpl = binding?.key_template ?? config.key_template ?? "{date}/{event_id}.json";
  const keyPrefix = binding?.key_prefix ?? config.key_prefix ?? "";
  const key = keyPrefix
    + tmpl.replaceAll("{date}", date).replaceAll("{event_id}", message.event_id);
  // SSRF guard on a custom S3-compatible endpoint (operator-set) before we PUT
  // the payload server-side — must not reach a metadata/internal host. AWS
  // (no custom endpoint) is unaffected.
  if (config.endpoint) {
    const epSsrf = validateDestinationUrl(config.endpoint);
    if (epSsrf) {
      console.error(`[delivery] s3 endpoint blocked (ssrf): ${epSsrf}`);
      return "dead";
    }
  }
  const url = config.endpoint
    ? buildS3CompatibleUrl(config.endpoint, config.bucket, key, config.addressing_style)
    : `https://${config.bucket}.s3.${config.region}.amazonaws.com/${key}`;
  const res = await aws.fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-amz-meta-event-id": message.event_id,
      "x-amz-meta-workspace-id": message.workspace_id,
    },
    body: payload,
  });
  if (res.ok) return "success";
  // Permanent auth (401/403) and missing-bucket (404) failures — dead-letter
  // instead of retrying forever (ROL-207). 401 covers S3-compatible stores that
  // return it for a bad/expired token where real AWS returns 403.
  if (res.status === 401 || res.status === 403 || res.status === 404) return "dead";
  return "retry";
}

function buildS3CompatibleUrl(
  endpoint: string,
  bucket: string,
  key: string,
  addressingStyle: S3Config["addressing_style"] = "path",
): string {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  if (addressingStyle === "virtual_hosted") {
    url.hostname = `${bucket}.${url.hostname}`;
    url.pathname = `${basePath}/${key}`;
  } else {
    url.pathname = `${basePath}/${bucket}/${key}`;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
}

// ---- Postgres ----------------------------------------------------------- //

interface PostgresConfig {
  connection_string: string;
  /**
   * Legacy fallback only — `table` lives on `route_destinations.binding`
   * since migration 0022. Optional here so a destination without the
   * legacy key still type-checks; the resolver throws if neither source
   * provides a table.
   */
  table?: string;
  columns?: Record<string, string>;
  payload_column?: string;
  idempotency_column?: string;
}

const pgClients = new Map<string, ReturnType<typeof postgres>>();
function getDestPg(connectionString: string): ReturnType<typeof postgres> {
  let client = pgClients.get(connectionString);
  if (!client) {
    client = postgres(connectionString, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      // Verify the server certificate by default (was "require", which encrypts
      // but accepts ANY cert → MITM on customer DB creds + delivered rows). A
      // customer DB with a self-signed / private-CA cert opts out with
      // `sslmode=no-verify` in its connection string.
      ssl: postgresJsSslOption(connectionString),
    });
    pgClients.set(connectionString, client);
  }
  return client;
}

/** Richer outcome so the dashboard's Response column shows the real PG error. */
type PgDelivery = { result: DeliveryResult; extra: Record<string, unknown> };

/**
 * SQLSTATEs that will NEVER succeed on retry — dead-letter them with a readable
 * message instead of looping forever. (Retrying "column does not exist" forever
 * is exactly the bug that hid this destination's failure: 0% success, "no
 * terminal failures", blank Response — because the error was both misclassified
 * as transient AND swallowed.)
 */
const TERMINAL_PG_SQLSTATES = new Set([
  "42P01", // undefined_table
  "42703", // undefined_column
  "42501", // insufficient_privilege
  "3D000", // invalid_catalog_name (database missing)
  "28P01", // invalid_password
  "28000", // invalid_authorization_specification
  "23502", // not_null_violation (config/schema mismatch)
  "23505", // unique_violation (idempotent dup — re-insert won't change it)
  "23514", // check_violation
  "22P02", // invalid_text_representation (type mismatch)
  "22003", // numeric_value_out_of_range
  "42804", // datatype_mismatch
  "42601", // syntax_error
]);

export function classifyPgError(err: unknown): { result: DeliveryResult; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code;
  if (code && TERMINAL_PG_SQLSTATES.has(code)) return { result: "dead", message };
  // Fall back to wording when the driver didn't surface a SQLSTATE.
  if (/(does not exist|violates|invalid input|permission denied|datatype mismatch)/i.test(message)) {
    return { result: "dead", message };
  }
  // Connection resets / timeouts / pool churn → transient, keep retrying.
  return { result: "retry", message };
}

// In-process schema cache per (connStr, table) — keeps information_schema off
// the hot path. Edge isolates persist across requests, so this survives like
// `pgClients`; a stale entry self-corrects on a 42703 (refresh + retry).
const pgColumnCache = new Map<string, Map<string, PgLeafType>>();
const pgTableInit = new Set<string>();

async function readPgColumnTypes(
  client: ReturnType<typeof postgres>,
  table: string,
): Promise<Map<string, PgLeafType>> {
  // Schema-qualified targets must filter on the real (schema, table) pair — the
  // bare string "app.events" would never match table_name. A bare name keeps the
  // search_path behaviour so an unqualified target resolves as before.
  const { schema, table: tableName } = splitPgTable(table);
  const rows = (await (table.includes(".")
    ? client.unsafe(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = $1 AND table_schema = $2`,
        [tableName, schema],
      )
    : client.unsafe(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_name = $1 AND table_schema = ANY(current_schemas(false))`,
        [tableName],
      ))) as unknown as Array<{ column_name: string; data_type: string }>;
  const m = new Map<string, PgLeafType>();
  // mapInfoSchemaType lives in @axel/shared/pg-columns so both drivers
  // classify live columns identically.
  for (const r of rows) m.set(r.column_name, mapInfoSchemaType(r.data_type));
  return m;
}

async function _deliverPostgres(
  payload: unknown,
  config: PostgresConfig,
  binding: RouteDestinationBinding | null | undefined,
): Promise<PgDelivery> {
  // Route-level binding wins; legacy `config.table` / `config.payload_column`
  // are the fallback for rows that pre-date migration 0022. Without either,
  // we have no target — dead-letter so the queue stops retrying.
  const resolved = resolvePostgresBinding(binding, config);
  if (!resolved) {
    return { result: "dead", extra: { error: "no table binding configured for this route/destination" } };
  }
  if (!isSafeTableIdent(resolved.table)) {
    return { result: "dead", extra: { error: `unsafe table identifier: ${resolved.table}` } };
  }

  const client = getDestPg(config.connection_string);
  const table = resolved.table;

  try {
    if (resolved.mode === "dotted_columns") {
      const summary = await insertDottedColumnsEdge(client, config.connection_string, table, payload);
      return { result: "success", extra: { table, mode: "dotted_columns", ...summary } };
    }

    if (config.columns && Object.keys(config.columns).length > 0) {
      // Legacy explicit column-mapping mode (JSONPath → column). Unchanged.
      const cols = Object.keys(config.columns).filter(isSafeIdent);
      if (cols.length !== Object.keys(config.columns).length) {
        return { result: "dead", extra: { table, error: "unsafe column identifier in column mapping" } };
      }
      const row: Record<string, unknown> = {};
      for (const c of cols) {
        const v = pickJsonPath(payload, config.columns![c]!);
        row[c] = v && typeof v === "object" ? client.json(v as never) : v;
      }
      const conflict = config.idempotency_column && isSafeIdent(config.idempotency_column)
        ? client`ON CONFLICT (${client(config.idempotency_column)}) DO NOTHING`
        : client``;
      await client`INSERT INTO ${client(table)} ${client(row)} ${conflict}`;
      return { result: "success", extra: { table, mode: "columns" } };
    }

    // jsonb_blob (default): one row, whole body in a single jsonb column. Now
    // self-healing — auto-creates the column if the shell table lacks it, so a
    // freshly-created table can't 100%-fail the way this destination did.
    const col = resolved.payload_column ?? "payload";
    if (!isSafeIdent(col)) {
      return { result: "dead", extra: { table, error: `unsafe payload column: ${col}` } };
    }
    const value: Record<string, unknown> = payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : { value: payload };
    await insertJsonbBlobEdge(client, table, col, value);
    return { result: "success", extra: { table, mode: "jsonb_blob", payload_column: col } };
  } catch (err) {
    const { result, message } = classifyPgError(err);
    return { result, extra: { table, mode: resolved.mode, error: message.slice(0, 500) } };
  }
}

/**
 * jsonb_blob insert via the known-correct template form (`client.json` encodes
 * the object exactly once). If the column is missing on a shell table (42703),
 * add it and retry once — so the default mode can't deadlock a fresh table.
 */
async function insertJsonbBlobEdge(
  client: ReturnType<typeof postgres>,
  table: string,
  col: string,
  value: Record<string, unknown>,
): Promise<void> {
  try {
    await client`INSERT INTO ${client(table)} (${client(col)}) VALUES (${client.json(value as never)})`;
  } catch (err) {
    if ((err as { code?: string })?.code === "42703") {
      await client.unsafe(`ALTER TABLE ${quotePgTable(table)} ADD COLUMN IF NOT EXISTS ${quotePgIdent(col)} jsonb`);
      await client`INSERT INTO ${client(table)} (${client(col)}) VALUES (${client.json(value as never)})`;
    } else {
      throw err;
    }
  }
}

/**
 * dotted_columns insert (postgres.js port of the Node reference). Flattens the
 * payload to dot-notation leaf columns, auto-adds any missing ones (widening an
 * existing column toward text/jsonb when a later event's type conflicts), then
 * INSERTs. Dotted identifiers carry literal dots, so we build the SQL with our
 * own `quotePgIdent` + `client.unsafe` (postgres.js's `client(name)` would split
 * "a.b" into "a"."b"); values are bound as parameters, jsonb leaves cast ::jsonb.
 */
async function insertDottedColumnsEdge(
  client: ReturnType<typeof postgres>,
  connectionString: string,
  table: string,
  payload: unknown,
): Promise<Record<string, unknown>> {
  const tableKey = `${connectionString}::${table}`;

  // First-touch: create the minimal shell so chronological ordering works even
  // if the dashboard's create-table step was skipped (defense in depth).
  if (!pgTableInit.has(tableKey)) {
    await client.unsafe(
      `CREATE TABLE IF NOT EXISTS ${quotePgTable(table)} (
         id bigserial PRIMARY KEY,
         received_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    pgTableInit.add(tableKey);
  }

  let colTypes = pgColumnCache.get(tableKey);
  if (!colTypes) {
    colTypes = await readPgColumnTypes(client, table);
    pgColumnCache.set(tableKey, colTypes);
  }

  // The add/widen/ALTER/INSERT planning is the shared pure planner
  // (@axel/shared pg-columns), identical to the delivery-service connector;
  // this side keeps only postgres.js execution and the schema cache. jsonb
  // params are "raw": postgres.js serialises the object/array behind the
  // `$n::jsonb` cast exactly once — JSON.stringify-ing first would re-encode
  // the string into a quoted jsonb string (verified empirically). Dotted
  // identifiers carry literal dots, so the planner builds the SQL with
  // quotePgIdent and we execute via `client.unsafe` (postgres.js's
  // `client(name)` would split "a.b" into "a"."b").
  const plan = planDottedColumnInsert(table, payload, colTypes, { jsonbParams: "raw" });
  if (!plan) return { rows: 0, skipped: "empty_payload" };

  if (plan.addColumnsSql) {
    // One statement so concurrent edge workers don't serialize on N ALTERs;
    // ADD COLUMN IF NOT EXISTS (nullable, no default) is metadata-only.
    await client.unsafe(plan.addColumnsSql);
    for (const a of plan.adds) colTypes.set(a.name, a.type);
  }
  for (let i = 0; i < plan.widens.length; i++) {
    await client.unsafe(plan.widenColumnSql[i]!);
    const w = plan.widens[i]!;
    colTypes.set(w.name, w.type);
  }

  try {
    await client.unsafe(plan.insertSql, plan.insertParams as never[]);
  } catch (err) {
    // Stale cache (column dropped/renamed externally) → refresh once and retry.
    if ((err as { code?: string })?.code === "42703") {
      pgColumnCache.delete(tableKey);
      const fresh = await readPgColumnTypes(client, table);
      pgColumnCache.set(tableKey, fresh);
      const repair = planColumnRepair(table, plan, fresh);
      if (repair.addColumnsSql) {
        await client.unsafe(repair.addColumnsSql);
        for (const a of repair.added) fresh.set(a.name, a.type);
      }
      await client.unsafe(plan.insertSql, plan.insertParams as never[]);
    } else {
      throw err;
    }
  }

  return {
    rows: 1,
    columns: plan.columns.length,
    columns_added: plan.adds.length,
    columns_widened: plan.widens.length,
  };
}

/**
 * Pull the effective `{ table, mode, payload_column? }` from either the route-
 * level binding (`route_destinations.binding`, migration 0022) or the legacy
 * destination config (which only ever meant jsonb_blob).
 */
function resolvePostgresBinding(
  binding: RouteDestinationBinding | null | undefined,
  config: PostgresConfig,
): { table: string; mode: PostgresBinding["mode"]; payload_column?: string } | null {
  if (binding && typeof binding === "object" && "table" in binding && typeof binding.table === "string") {
    const b = binding as PostgresBinding;
    return {
      table: b.table,
      mode: b.mode === "dotted_columns" ? "dotted_columns" : "jsonb_blob",
      ...(b.payload_column !== undefined ? { payload_column: b.payload_column } : {}),
    };
  }
  if (typeof config.table === "string" && config.table.length > 0) {
    return {
      table: config.table,
      mode: "jsonb_blob",
      ...(config.payload_column !== undefined ? { payload_column: config.payload_column } : {}),
    };
  }
  return null;
}

function pickObjectStoreBinding(
  binding: RouteDestinationBinding | null | undefined,
): ObjectStoreBinding | null {
  if (!binding || typeof binding !== "object") return null;
  if ("table" in binding || "collection" in binding || "volume" in binding) return null;
  return binding as ObjectStoreBinding;
}

function isSafeIdent(s: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

// Strip trailing "/" without a backtracking regex. `/\/+$/` is flagged
// js/polynomial-redos on operator-controlled key prefixes; a linear scan is
// equivalent and can't degrade.
function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end -= 1;
  return s.slice(0, end);
}

// A table reference may be `table` or `schema.table` (the dashboard picker emits
// the qualified form for non-public schemas). Allow exactly one optional dot,
// each side a plain identifier — quotePgTable then quotes the two parts
// separately. Columns must NOT use this (they keep literal dots via isSafeIdent).
function isSafeTableIdent(s: string): boolean {
  const parts = s.split(".");
  if (parts.length > 2) return false;
  return parts.every((p) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(p));
}

function pickJsonPath(payload: unknown, path: string): unknown {
  if (path === "$") return payload;
  if (!path.startsWith("$.")) return path;
  const segments = path.slice(2).split(".");
  let current: unknown = payload;
  for (const seg of segments) {
    if (current && typeof current === "object" && seg in (current as Record<string, unknown>)) {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return current;
}

// =========================================================================
// Dead-letter recorder
// =========================================================================
//
// Bridges the Cloudflare `axel-dead-letter` queue into the Postgres
// `dead_letters` table. Two payload shapes flow through this queue:
//
//   1. Explicit DLQ writes from router-edge (when filter/transform sandbox
//      is unavailable, or the R2 raw payload is missing). These already
//      include `reason`, `message`, and a router-side `errored_at`.
//
//   2. Cloudflare's automatic DLQ when a queue consumer exceeds max_retries.
//      For axel-events-XX, the original `QueueMessage` shape is dumped here.
//      For axel-delivery, the original `DestinationQueueMessage` is dumped.
//      Neither carries a reason, so we synthesize one from `batch.queue` /
//      message attempts so the row is still useful.
//
// All writes are idempotent — the (event_id, route_id, destination_id)
// triplet plus errored_at timestamp acts as a natural-ish key. If a duplicate
// arrives we tolerate it and log; the dashboard filters by event_id anyway.

interface RouterDeadLetterPayload {
  workspace_id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  // Present for per-destination failures; null for route-level / pre-routing
  // failures and the CF auto-DLQ fallback when the body lacks it.
  destination_id: string | null;
  r2_key: string;
  reason: string;
  message: string;
  errored_at: string;
}

interface QueueDeadLetterFallback {
  workspace_id?: string;
  event_id?: string;
  source_id?: string;
  route_id?: string;
  destination_id?: string;
  r2_key?: string;
  // Anything else is preserved as JSON in the metadata column.
  [k: string]: unknown;
}

async function drainDeadLetterQueue(
  batch: MessageBatch<unknown>,
  env: Env,
): Promise<void> {
  const client = createSql(env);
  const spillReader = spillReaderFromR2(env.EVENTS_RAW);
  try {
    for (const msg of batch.messages) {
      try {
        const body = msg.body;
        if (!body || typeof body !== "object") {
          // Unparseable payload — ack so we don't loop. We log the raw form
          // so an operator can recover it from CF tail if needed.
          console.error(`[dlq-recorder] dropping non-object message id=${msg.id}`);
          msg.ack();
          continue;
        }
        const normalized = normalizeDeadLetterRow(body as Record<string, unknown>);
        // Fingerprint from the normalized (stored) route_id/reason/message — the
        // route_id is already '' for route-level failures, which matches the
        // inbox's `?? ''` coalesce.
        const fingerprint = await deadLetterFingerprint({
          route_id: normalized.route_id,
          reason: normalized.reason,
          message: normalized.message,
        });
        await client`
          INSERT INTO dead_letters
            (workspace_id, event_id, source_id, route_id, destination_id, r2_key, reason, message, errored_at, fingerprint)
          VALUES (
            ${normalized.workspace_id},
            ${normalized.event_id},
            ${normalized.source_id},
            ${normalized.route_id},
            ${normalized.destination_id},
            ${normalized.r2_key},
            ${normalized.reason},
            ${normalized.message},
            ${normalized.errored_at},
            ${fingerprint}
          )
          ON CONFLICT DO NOTHING
        `;
        // The delivery is permanently dead now that its dead_letters row is
        // durable. Drop the queue-spill object (oversized payload/headers/query
        // copy) if this message carried one: no retry will hydrate it, and
        // replay re-reads the raw event payload (events/…), not the spill. The
        // normal "dead" path already deletes it; auto-DLQ'd messages that
        // exhausted max_retries reached here without cleanup and leaked the
        // object into R2 forever.
        const spillKey = (body as { spill_r2_key?: unknown }).spill_r2_key;
        if (typeof spillKey === "string" && spillKey.length > 0) {
          await spillReader.delete(spillKey).catch(() => undefined);
        }
        msg.ack();
      } catch (err) {
        // Postgres unreachable / schema drift / etc. Retry — Cloudflare will
        // re-deliver, and after this consumer's max_retries it'll expire from
        // the queue. We deliberately don't chain to another DLQ; that just
        // hides the problem.
        const summary = err instanceof Error ? err.message : String(err);
        console.error(`[dlq-recorder] insert failed (retry): ${summary}`);
        msg.retry();
      }
    }
  } finally {
    await client.end({ timeout: 1 }).catch(() => undefined);
  }
}

/**
 * Fold either dead-letter shape (router-explicit, queue-auto) into the
 * fields the `dead_letters` Postgres table expects. Missing fields get
 * empty strings so the NOT NULL columns pass.
 */
function normalizeDeadLetterRow(body: Record<string, unknown>): RouterDeadLetterPayload {
  // Shape 1: router-edge explicit write.
  if (typeof body.reason === "string" && typeof body.message === "string") {
    const r = body as unknown as RouterDeadLetterPayload;
    return {
      workspace_id: r.workspace_id ?? "",
      event_id: r.event_id ?? "",
      source_id: r.source_id ?? "",
      route_id: r.route_id ?? "",
      destination_id: typeof r.destination_id === "string" && r.destination_id.length > 0
        ? r.destination_id
        : null,
      r2_key: r.r2_key ?? "",
      reason: r.reason,
      // Router-level messages are internal diagnostics (declarative/eval-free
      // transforms reference field paths, not values), so they aren't scrubbed —
      // scrubbing happens at the connector-error insert points instead.
      message: r.message,
      errored_at: r.errored_at ?? new Date().toISOString(),
    };
  }
  // Shape 2: CF auto-DLQ fallback. We don't know which queue gave up on it,
  // so the reason is generic. The caller can tell from the source_id +
  // route_id combination whether it was an event-shard exhaust or a delivery
  // retry exhaust.
  const f = body as QueueDeadLetterFallback;
  return {
    workspace_id: typeof f.workspace_id === "string" ? f.workspace_id : "",
    event_id: typeof f.event_id === "string" ? f.event_id : "",
    source_id: typeof f.source_id === "string" ? f.source_id : "",
    route_id: typeof f.route_id === "string" ? f.route_id : "",
    destination_id: typeof f.destination_id === "string" && f.destination_id.length > 0
      ? f.destination_id
      : null,
    r2_key: typeof f.r2_key === "string" ? f.r2_key : "",
    reason: "max_retries_exceeded",
    message: `Cloudflare auto-DLQ after exceeding consumer max_retries${typeof f.destination_id === "string" ? ` (destination=${f.destination_id})` : ""}`,
    errored_at: new Date().toISOString(),
  };
}
