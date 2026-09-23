import { deriveSubjectIdWeb, extractEventTypeFromBody, extractEventTypeFromHeaders, extractSubjectPairs, ipMatchesAllowlist, redactJsonPayload, resolveInternalServiceEndpoint, resolveOrderingKey, sanitizeConnectorDiagnosticForStorage, shardFor, validateInternalServiceEndpoint, verifyProviderSignatureWithSecrets, type QueueMessage, type Source } from "@axel/shared";
import { captureException, isCloudflareQueueInternalError, isCloudflareQueueOverloadError, isTransientR2Error, recordHeartbeatHttp, sentryClientFromEnv, type SentryEnv } from "@axel/observability";
import { exceedsJsonDepth, looksLikeJson } from "./depth.js";
import { kvPlanCache, type PlanCache } from "./plan-cache.js";
import { checkTokenBucket } from "./rate-limit.js";
import { kvSourceCache, type KVNamespaceLike, type SourceCache } from "./source-cache.js";
import { handleSourceAuthorityFence, handleSourceAuthoritySync, handleSourceCacheInvalidate, handleSourceCachePut, handleTriggerEvent, handleWorkspacePayloadDeleteBatch, handleWorkspacePlanPut } from "./admin.js";
import { indexErasureSubjectsFromDeliveryService } from "./erasure-index-http.js";
import { indexErasureSubjects as indexErasureSubjectsInPostgres, lookupSourceInPostgres } from "./source-lookup-pg.js";
import { lookupSourceFromDeliveryService } from "./source-lookup-http.js";
import { SourceLookupUnavailableError } from "./source-lookup-error.js";
import { logEventToClickhouse } from "./clickhouse-log.js";
import { beginSourceAuthorizationWithAuthority, confirmSourceAuthorizationWithAuthority, sourceAuthorityAdminClient, type SourceAuthorityNamespaceLike } from "./source-authority.js";
import { allowsLegacyQueryToken } from "./legacy-query-token.js";

export { SourceAuthorityDurableObject } from "./source-authority.js";

export interface Env extends SentryEnv {
  EVENTS_RAW: R2Bucket;
  QUEUE_EVENTS_00: Queue<QueueMessage>;
  QUEUE_EVENTS_01: Queue<QueueMessage>;
  QUEUE_EVENTS_02: Queue<QueueMessage>;
  QUEUE_EVENTS_03: Queue<QueueMessage>;
  QUEUE_EVENTS_04: Queue<QueueMessage>;
  QUEUE_EVENTS_05: Queue<QueueMessage>;
  QUEUE_EVENTS_06: Queue<QueueMessage>;
  QUEUE_EVENTS_07: Queue<QueueMessage>;
  QUEUE_EVENTS_08: Queue<QueueMessage>;
  QUEUE_EVENTS_09: Queue<QueueMessage>;
  QUEUE_EVENTS_10: Queue<QueueMessage>;
  QUEUE_EVENTS_11: Queue<QueueMessage>;
  QUEUE_EVENTS_12: Queue<QueueMessage>;
  QUEUE_EVENTS_13: Queue<QueueMessage>;
  QUEUE_EVENTS_14: Queue<QueueMessage>;
  QUEUE_EVENTS_15: Queue<QueueMessage>;
  /** KV is retained for workspace plan state and rollback cleanup only. */
  SOURCE_CACHE?: KVNamespaceLike;
  /** Legacy source-cache override used by admin endpoint tests. */
  __SOURCE_CACHE_OVERRIDE?: SourceCache;
  /** Hosted, strongly consistent per-source authorization state. */
  SOURCE_AUTHORITY?: SourceAuthorityNamespaceLike;
  /** Hosted profiles fail closed if the Durable Object binding is missing. */
  SOURCE_AUTHORITY_REQUIRED?: string;
  /**
   * HMAC key used to pseudonymize per-customer FIFO ordering values before
   * they leave this worker. Required for every hosted ingest request and for
   * any self-hosted source that enables ordered delivery.
   */
  ORDERING_KEY_HMAC_SECRET?: string;
  /**
   * Optional override PlanCache (test injection point). In production
   * the plan cache reuses the SOURCE_CACHE KV binding with a
   * `ws-plan:` key prefix — no separate binding required.
   */
  __PLAN_CACHE_OVERRIDE?: PlanCache;
  /**
   * Shared secret for the admin endpoint surface (`/admin/*`). When unset,
   * admin routes return 404 — they're effectively disabled. Production
   * deployments must set this and front the worker with Cloudflare Access.
   */
  ADMIN_TOKEN?: string;
  /** Operator-only, per-source migration windows (at most 72 hours). Disabled by default. */
  LEGACY_QUERY_TOKEN_SOURCES?: string;
  /**
   * Optional ClickHouse Cloud HTTPS endpoint for analytics-row logging.
   * When set, every accepted webhook also produces an `events` row that
   * powers the dashboard's /usage and /sources/[id] pages. Writes go via
   * `ctx.waitUntil` so they never block the 202 response.
   */
  CLICKHOUSE_URL?: string;
  CLICKHOUSE_USER?: string;
  CLICKHOUSE_PASSWORD?: string;
  // Local dev only — set via .dev.vars, never in production [vars]. Optional so
  // production (where it's absent) typechecks and the DEV_SOURCES branch is off.
  DEV_MODE?: string;
  DEV_SOURCES?: string;
  /**
   * Local-development Postgres fallback only. Production source lookup and
   * erasure indexing both go through the authenticated delivery service.
   */
  DATABASE_URL?: string;
  /**
   * Local-dev only: AES-256-GCM key for the direct Postgres source fallback.
   * Production decryption happens inside delivery-service.
   */
  CREDENTIALS_MASTER_KEY?: string;
  MAX_BODY_BYTES?: string;
  MAX_BODY_DEPTH?: string;
  /** Heartbeat ingress on delivery-service. Auto-derived from
   *  `DELIVERY_SERVICE_URL` when `DELIVERY_HEARTBEAT_URL` is unset.
   *  Both fall back to a no-op silently — heartbeat failure must
   *  never crash ingest, and a not-yet-wired worker should look
   *  "unknown" on the health page rather than 500ing on the hot
   *  path. */
  DELIVERY_SERVICE_URL?: string;
  DELIVERY_HEARTBEAT_URL?: string;
  /** Dedicated credential for POST /internal/source. During the rollout only,
   *  source lookup falls back to DELIVERY_SHARED_SECRET when this is absent. */
  SOURCE_LOOKUP_SHARED_SECRET?: string;
  /** Authenticates heartbeat calls; deliberately separate from source lookup
   *  once SOURCE_LOOKUP_SHARED_SECRET is provisioned. */
  DELIVERY_SHARED_SECRET?: string;
}

const MAX_BODY_BYTES = 1_048_576;
const MAX_BODY_DEPTH = 100;
const QUEUE_SEND_RETRY_ATTEMPTS = 3;
const QUEUE_SEND_RETRY_BASE_MS = 100;

// Heartbeat throttle — once per minute is plenty; ingest is a hot
// path and we don't want to write a DB row per request. State is
// module-scoped so it survives across requests handled by the same
// isolate (Cloudflare Workers reuse isolates for warm hits).
let lastHeartbeatAt = 0;
let heartbeatTickCount = 0;
const HEARTBEAT_THROTTLE_MS = 60 * 1000;

function maybeBeatIngest(env: Env, ctx: ExecutionContext, error?: string): void {
  let url: string | null = null;
  try {
    url = env.DELIVERY_HEARTBEAT_URL
      ? validateInternalServiceEndpoint(env.DELIVERY_HEARTBEAT_URL, "/internal/heartbeat")
      : env.DELIVERY_SERVICE_URL
        ? resolveInternalServiceEndpoint(env.DELIVERY_SERVICE_URL, "/internal/heartbeat")
        : null;
  } catch {
    return;
  }
  if (!url || !env.DELIVERY_SHARED_SECRET) return;
  const now = Date.now();
  if (now - lastHeartbeatAt < HEARTBEAT_THROTTLE_MS && !error) return;
  lastHeartbeatAt = now;
  heartbeatTickCount += 1;
  ctx.waitUntil(
    recordHeartbeatHttp(url, env.DELIVERY_SHARED_SECRET, {
      component: "ingest-worker",
      tickCount: heartbeatTickCount,
      ...(error ? { error } : {}),
      // Generous tolerance: we only beat every 60s by design.
      expectedIntervalSeconds: 180,
      environment: env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV ?? "production",
    }),
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const sentry = sentryClientFromEnv(env, "ingest-worker");
    try {
      const response = await handleFetch(request, env, ctx);
      maybeBeatIngest(env, ctx);
      return response;
    } catch (err) {
      // AXE-65 — queue producer rate-limit (10250) is transient
      // backpressure. Signal the client to back off via 503 +
      // Retry-After rather than reporting as a code bug and 5xx-ing
      // with a generic exception.
      if (isCloudflareQueueOverloadError(err)) {
        return json(
          { error: "queue_overloaded", retry_after_seconds: 5 },
          503,
          { "retry-after": "5" },
        );
      }
      // Queue code 15000 is a transient Cloudflare platform failure. The shard
      // writer already retried the same message/event id in-process; return a
      // structured 503 so an exhausted attempt is retried by the producer
      // without creating a Sentry code-bug issue.
      if (isCloudflareQueueInternalError(err)) {
        return json(
          { error: "queue_unavailable", retry_after_seconds: 2 },
          503,
          { "retry-after": "2" },
        );
      }
      // AXE-149 — R2 transient internal errors ("Please try again. (10001)").
      // Same shape as queue overload: 503 + retry-after, no Sentry capture.
      if (isTransientR2Error(err)) {
        return json(
          { error: "storage_unavailable", retry_after_seconds: 2 },
          503,
          { "retry-after": "2" },
        );
      }
      // Source control plane unreachable or returned an invalid response.
      // Transient → 503 + retry-after so the producer retries instead of us
      // caching a wrong negative. DB-down on the hot path is serious, so DO
      // capture it (unlike the expected queue/R2 backpressure above).
      if (err instanceof SourceLookupUnavailableError) {
        ctx.waitUntil(captureException(sentry, err, {
          fingerprint: ["source_lookup", err.reason],
          tags: { component: "source_lookup", reason: err.reason, http_status: err.httpStatus },
        }));
        return json(
          { error: "source_lookup_unavailable", retry_after_seconds: 2 },
          503,
          { "retry-after": "2" },
        );
      }
      ctx.waitUntil(captureException(sentry, err, {
        tags: {
          component: "fetch",
          method: request.method,
          path: new URL(request.url).pathname,
        },
      }));
      // Keep raw exception text out of the durable heartbeat row. Sentry receives
      // the sanitized diagnostic through the capture boundary above.
      maybeBeatIngest(env, ctx, "ingest_request_failed");
      return json({ error: "internal_error" }, 500);
    }
  },
};

async function handleFetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Public liveness probe — used by the public /status page so the
    // synthetic HTTP check has something to hit. No DB or KV lookups;
    // 200 here only proves the worker isolate is up, which is exactly
    // what /health endpoints are for. The component_heartbeats row
    // (written via ctx.waitUntil on real requests) is what proves
    // the work loop is actually accepting messages.
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/health" || url.pathname === "/")
    ) {
      return json({ ok: true, service: "ingest-worker", at: new Date().toISOString() }, 200);
    }

    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405);
    }

    if (url.pathname === "/admin/source-cache/invalidate") {
      return handleSourceCacheInvalidate(request, {
        cache: env.__SOURCE_CACHE_OVERRIDE
          ?? (env.SOURCE_CACHE ? kvSourceCache(env.SOURCE_CACHE) : null),
        authority: sourceAuthorityAdminClient(
          env.SOURCE_AUTHORITY,
          env.SOURCE_AUTHORITY_REQUIRED === "true",
        ),
        adminToken: env.ADMIN_TOKEN,
      });
    }
    if (url.pathname === "/admin/source-cache/put") {
      return handleSourceCachePut(request, {
        cache: env.__SOURCE_CACHE_OVERRIDE
          ?? (env.SOURCE_CACHE ? kvSourceCache(env.SOURCE_CACHE) : null),
        authority: sourceAuthorityAdminClient(
          env.SOURCE_AUTHORITY,
          env.SOURCE_AUTHORITY_REQUIRED === "true",
        ),
        adminToken: env.ADMIN_TOKEN,
      });
    }
    if (url.pathname === "/admin/source-authority/fence") {
      return handleSourceAuthorityFence(request, {
        cache: env.__SOURCE_CACHE_OVERRIDE
          ?? (env.SOURCE_CACHE ? kvSourceCache(env.SOURCE_CACHE) : null),
        authority: sourceAuthorityAdminClient(
          env.SOURCE_AUTHORITY,
          env.SOURCE_AUTHORITY_REQUIRED === "true",
        ),
        adminToken: env.ADMIN_TOKEN,
      });
    }
    if (url.pathname === "/admin/source-authority/sync") {
      return handleSourceAuthoritySync(request, {
        cache: env.__SOURCE_CACHE_OVERRIDE
          ?? (env.SOURCE_CACHE ? kvSourceCache(env.SOURCE_CACHE) : null),
        authority: sourceAuthorityAdminClient(
          env.SOURCE_AUTHORITY,
          env.SOURCE_AUTHORITY_REQUIRED === "true",
        ),
        adminToken: env.ADMIN_TOKEN,
      });
    }
    if (url.pathname === "/admin/workspace-plan/put") {
      return handleWorkspacePlanPut(request, {
        planCache: planCacheFor(env),
        adminToken: env.ADMIN_TOKEN,
      });
    }
    if (url.pathname === "/admin/workspace-payloads/delete-batch") {
      return handleWorkspacePayloadDeleteBatch(request, {
        adminToken: env.ADMIN_TOKEN,
        rawPayloads: env.EVENTS_RAW,
      });
    }
    if (url.pathname === "/admin/trigger-event") {
      return handleTriggerEvent(request, {
        beginSourceAuthorization: (sourceId) =>
          beginSourceAuthorizationWithAuthority(
            env,
            sourceId,
            (id) => lookupSourceUncached(env, id),
          ),
        confirmSourceAuthorization: (sourceId, authorizationVersion) =>
          confirmSourceAuthorizationWithAuthority(
            env,
            sourceId,
            authorizationVersion,
          ),
        adminToken: env.ADMIN_TOKEN,
        rawPayloads: env.EVENTS_RAW,
        queueForShard: (shard) => queueForShard(env, shard),
        uuid: () => uuidv7(),
        shardFor,
        ctx,
        indexSubjects: ({ source, rawBody, headers, query, eventId, r2Key, receivedAt }) =>
          indexSubjectsForErasure(env, source, rawBody, headers, query, eventId, r2Key, receivedAt),
        logEvent: (message) => logEventToClickhouse(env, message),
      });
    }

    const match = /^\/in\/([^/]+)$/.exec(url.pathname);
    if (!match) return json({ error: "not_found" }, 404);

    const sourceId = match[1]!;
    // Headerless senders use a separate URL credential. Legacy header tokens
    // in URLs require an explicit, expiring source migration window.
    const queryTokens = url.searchParams.getAll("token");
    const urlTokens = url.searchParams.getAll("url_token");
    const headerToken = request.headers.get("x-axel-token");
    const legacyQuery = queryTokens.length === 1 && Boolean(queryTokens[0])
      && headerToken === null && urlTokens.length === 0
      && allowsLegacyQueryToken(env.LEGACY_QUERY_TOKEN_SOURCES, sourceId);
    if (queryTokens.length > 0 && !legacyQuery) {
      return json({ error: "query_token_not_allowed" }, 401);
    }
    if (urlTokens.length > 1 || (urlTokens.length > 0 && headerToken !== null)) {
      return json({ error: "ambiguous_authentication" }, 401);
    }


    const authorization = await beginSourceAuthorizationWithAuthority(
      env,
      sourceId,
      (id) => lookupSourceUncached(env, id),
    );
    const source = authorization.source;
    if (!source) return json({ error: "unknown_source" }, 404);
    if (source.status !== "active") return json({ error: "source_disabled" }, 403);
    const provider = source.provider ?? "custom";
    // The compatibility window cannot substitute token auth for a provider's signature.
    if (legacyQuery && provider !== "custom") return json({ error: "query_token_not_allowed" }, 401);
    // AXE-34 — inbound IP allowlist. When set, reject any IP outside
    // the union (cheaper than running token verify on forged traffic;
    // 403 is non-billable). `cf-connecting-ip` is the canonical
    // client-IP header at the Cloudflare edge.
    if (source.inbound_ip_allowlist && source.inbound_ip_allowlist.length > 0) {
      const connectingIp = request.headers.get("cf-connecting-ip") ?? "";
      if (!ipMatchesAllowlist(connectingIp, source.inbound_ip_allowlist)) {
        return json({ error: "ip_not_allowlisted" }, 403);
      }
    }
    if (urlTokens.length > 0 && (provider !== "custom" || !source.url_token_hash)) {
      return json({ error: "url_authentication_disabled" }, 401);
    }
    if (provider === "custom") {
      const presentedToken = legacyQuery ? queryTokens[0] : urlTokens.length > 0 ? urlTokens[0] : headerToken;
      if (!presentedToken) return json({ error: "missing_token" }, 401);
      // The stored token is a SHA-256 hex hash. Compare hashes in constant time
      // and keep plaintext confined to this request's memory.
      const presentedHash = await sha256Hex(presentedToken);
      const expectedHash = urlTokens.length > 0 ? source.url_token_hash! : source.secret_token;
      if (!safeEqual(expectedHash, presentedHash)) {
        return json({ error: "invalid_token" }, 401);
      }
    }

    const maxBodyBytes = source.max_body_bytes ?? parsePositiveInt(env.MAX_BODY_BYTES, MAX_BODY_BYTES);
    const maxBodyDepth = source.max_body_depth ?? parsePositiveInt(env.MAX_BODY_DEPTH, MAX_BODY_DEPTH);

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > maxBodyBytes) return json({ error: "payload_too_large" }, 413);

    const body = await request.arrayBuffer();
    if (body.byteLength > maxBodyBytes) return json({ error: "payload_too_large" }, 413);

    const contentType = request.headers.get("content-type") ?? "application/octet-stream";
    if (looksLikeJson(contentType) && exceedsJsonDepth(new Uint8Array(body), maxBodyDepth)) {
      return json({ error: "payload_too_deep" }, 413);
    }

    // AXE-23: per-provider signature verification. Must run BEFORE R2
    // write + queue enqueue — a spoofed payload that gets through here
    // is durable, billable, and will fan out to destinations. Custom sources
    // may remain token-only for backwards compatibility. A
    // named provider, however, must never degrade to token-only merely because
    // its decrypted secret is absent from the edge Source shape.
    const hasSigningSecret =
      (source.signing_secret?.length ?? 0) > 0
      || (source.signing_secret_previous?.length ?? 0) > 0;
    if (provider !== "custom" && !hasSigningSecret) {
      throw new SourceLookupUnavailableError(
        "provider signing verification is unavailable",
      );
    }
    const verificationHeaders = hasSigningSecret ? collectVerificationHeaders(request) : null;
    if (hasSigningSecret && verificationHeaders) {
      // Verification needs the exact inbound auth headers. Chargebee signs via
      // HTTP Basic auth, so using the sanitized persistence map here would
      // strip `authorization` and reject every valid Chargebee webhook.
      // Verify against the current secret first, then the previous one during a
      // rotation overlap window — a webhook signed with the old secret while the
      // customer rotates still passes until the previous secret is retired.
      const result = await verifyProviderSignatureWithSecrets(
        { provider, body: new Uint8Array(body), headers: verificationHeaders },
        [source.signing_secret, source.signing_secret_previous],
      );
      if (!result.ok) {
        // 401 with a stable reason slug, not the secret. The reason
        // matches the SignatureVerifyResult enum so support can
        // diagnose without per-request logs.
        return json({ error: "invalid_signature", reason: result.reason }, 401);
      }
    }

    // Billing and source rate gates run only after the request is authenticated
    // by a custom-source credential or a named-provider signature.
    const planCache = planCacheFor(env);
    if (planCache) {
      const planState = await planCache.get(source.workspace_id);
      if (planState?.gate === "reject_suspended") {
        return json({ error: "billing_suspended" }, 402);
      }
      if (planState?.gate === "reject_quota") {
        return json({ error: "plan_quota_exceeded" }, 429);
      }
    }

    if (source.max_events_per_minute) {
      const rate = checkTokenBucket({
        key: `${source.workspace_id}:${source.source_id}`,
        limitPerMinute: source.max_events_per_minute,
      });
      if (!rate.allowed) {
        return json(
          { error: "rate_limited" },
          429,
          { "retry-after": String(rate.retryAfterSeconds ?? 1) },
        );
      }
    }

    // Signed providers publish a stable delivery/event identity. Bind it to the
    // Axel source, hash it, and use the digest for both event_id and the raw R2
    // key. Provider retries therefore remain one logical Axel event even across
    // Worker isolates. A retry is still safe to enqueue after a partial failure:
    // the 30-day delivery-idempotency claim sees the same event id and suppresses
    // duplicate external effects.
    const providerEventId = verificationHeaders
      ? await deterministicProviderEventId(
          source.source_id,
          provider,
          new Uint8Array(body),
          verificationHeaders,
        )
      : null;
    const eventId = providerEventId ?? uuidv7();
    let receivedAt = new Date().toISOString();
    const r2Key = providerEventId
      ? `events/${source.workspace_id}/provider/${eventId}`
      : `events/${source.workspace_id}/${receivedAt.slice(0, 10)}/${eventId}`;

    // These request-derived maps exist only in this request's memory. They are
    // needed for ordering, event-type, test-marker, and erasure derivation, but
    // their values must never enter Queue, ClickHouse, CLI, or dashboard data.
    const derivedHeaders = collectHeaders(request);
    const derivedQuery = collectQuery(url);

    const orderingHmacSecret = env.ORDERING_KEY_HMAC_SECRET?.trim() ?? "";
    if (
      (env.SOURCE_AUTHORITY_REQUIRED === "true" || source.ordering_enabled === true)
      && orderingHmacSecret.length < 32
    ) {
      throw new SourceLookupUnavailableError("ordering key HMAC is unavailable");
    }

    // FIFO Phase 1 — resolve the per-source ordering key from the PRE-redaction
    // body (or a header) so same-key events co-locate on one shard. Default-off:
    // null unless the source opted in AND a key resolved, in which case we fall
    // back to event_id sharding exactly as before. A missing/unresolvable key
    // NEVER drops the event. Later phases serialize delivery per key.
    const orderingKey = await resolveOrderingKey(
      source,
      new Uint8Array(body),
      derivedHeaders,
      orderingHmacSecret,
    );

    // Only authenticated, named providers may add a bounded canonical type to
    // analytics. Custom webhook fields and headers can contain arbitrary
    // customer values, so custom sources remain untyped by default.
    const eventType = provider === "custom"
      ? ""
      : boundedProviderEventType(
          looksLikeJson(contentType)
            ? extractEventTypeFromBody(new Uint8Array(body), derivedHeaders)
            : extractEventTypeFromHeaders(derivedHeaders) ?? "",
        );

    // PII redaction — mask configured paths BEFORE the durable R2 write, so
    // masked fields never persist and are never delivered. Runs after signature
    // verification (which needs the original body). No-op unless the source
    // configured redact_paths; non-JSON bodies pass through unchanged.
    const storedBody =
      source.redact_paths && source.redact_paths.length > 0
        ? redactJsonPayload(new Uint8Array(body), source.redact_paths)
        : body;

    // A source may be fenced while this worker reads the body and checks its
    // provider signature. Reconfirm the exact authority version immediately
    // before the first durable write. A rotation, disable, delete, suspension,
    // or TTL refresh makes this fail closed with a retryable 503.
    await confirmSourceAuthorizationWithAuthority(
      env,
      sourceId,
      authorization.authorizationVersion,
    );

    const stored = await env.EVENTS_RAW.put(r2Key, storedBody, {
      ...(providerEventId ? { onlyIf: { etagDoesNotMatch: "*" } } : {}),
      httpMetadata: {
        contentType,
      },
      customMetadata: {
        event_id: eventId,
        workspace_id: source.workspace_id,
        source_id: source.source_id,
        received_at: receivedAt,
      },
    });
    if (providerEventId && stored === null) {
      // A prior copy won the conditional create. Reuse its original receipt
      // time so analytics and responses remain stable. Always enqueue below:
      // the first Worker may have stopped after R2 but before Queue, and the
      // deterministic downstream idempotency key makes that recovery safe.
      const prior = await env.EVENTS_RAW.head(r2Key);
      const priorReceivedAt = prior?.customMetadata?.received_at;
      if (!isIsoTimestamp(priorReceivedAt)) {
        throw new Error("provider_replay_object_missing_metadata");
      }
      receivedAt = priorReceivedAt;
    }

    // Co-locate same-key events on one shard for ordered sources; unordered
    // events still scatter by random event_id exactly as before.
    const shard = shardFor(orderingKey ?? eventId);
    const message: QueueMessage = {
      event_id: eventId,
      workspace_id: source.workspace_id,
      source_id: source.source_id,
      r2_key: r2Key,
      received_at: receivedAt,
      content_type: contentType,
      size_bytes: storedBody.byteLength,
      shard,
      // Raw request metadata is request-local only. Persist value-free maps so
      // arbitrary webhook secrets cannot reach Queue, ClickHouse, CLI, or UI.
      headers: {},
      query: {},
      // Public senders cannot opt traffic out of billing. Test events are
      // created only by the separately authenticated admin trigger endpoint.
      is_test: false,
      // Stamp the event type only when one was found, so the message stays
      // byte-identical to baseline for non-JSON / untyped sources.
      ...(eventType ? { event_type: eventType } : {}),
      // Stamp the ordering key only when one resolved — so the message is
      // byte-identical to baseline for the unordered default.
      ...(orderingKey ? { ordering_key: orderingKey } : {}),
    };

    await sendToShard(env, shard, message);
    // Fire the ClickHouse analytics row after the durable R2 + queue path.
    // ClickHouse failure just leaves a hole in the dashboard view.
    ctx.waitUntil(logEventToClickhouse(env, message));

    // GDPR erasure index: for sources that opted into subject_key_paths, derive
    // the (pseudonymous) subject_ids on THIS event and index them so an erasure
    // request can later locate the event by subject. Extracted from the ORIGINAL
    // body (not the redacted storedBody) — subject_id is a hash, so it stays
    // pseudonymous even when the path overlaps a redact path. Non-blocking; no-op
    // for sources without subject indexing.
    ctx.waitUntil(indexSubjectsForErasure(
      env,
      source,
      new Uint8Array(body),
      derivedHeaders,
      derivedQuery,
      eventId,
      r2Key,
      receivedAt,
    ));

    return json({ event_id: eventId, received_at: receivedAt }, 202);
}

/**
 * Best-effort: must never throw out of ctx.waitUntil. Extracts subject (kind,
 * value) pairs per the source's subject_key_paths, derives subject_ids with the
 * shared Web-Crypto deriver (byte-identical to the dashboard read-path), and
 * sends erasure_subjects to the delivery service in production. Local
 * development may still use its explicitly configured Postgres connection.
 */
async function indexSubjectsForErasure(
  env: Env,
  source: Source,
  rawBody: Uint8Array,
  headers: Record<string, string>,
  query: Record<string, string>,
  eventId: string,
  r2Key: string,
  receivedAt: string,
): Promise<void> {
  try {
    const pairs = extractSubjectPairs(source, rawBody, headers, query);
    if (pairs.length === 0) return;
    const ids = await Promise.all(pairs.map((p) => deriveSubjectIdWeb(source.workspace_id, p.kind, p.value)));
    const uniqueIds = [...new Set(ids)];
    if (env.DEV_MODE === "true" && env.DATABASE_URL) {
      await indexErasureSubjectsInPostgres(
        env,
        source.workspace_id,
        uniqueIds,
        eventId,
        r2Key,
        receivedAt,
      );
    } else {
      await indexErasureSubjectsFromDeliveryService(
        env,
        source.source_id,
        uniqueIds,
        eventId,
        r2Key,
        receivedAt,
      );
    }
  } catch (err) {
    console.error(
      `[ingest] erasure subject index failed: ${sanitizeConnectorDiagnosticForStorage(err)}`,
    );
  }
}

async function sendToShard(
  env: Env,
  shard: number,
  message: QueueMessage,
): Promise<void> {
  const queue = queueForShard(env, shard);
  let lastError: unknown;
  for (let attempt = 1; attempt <= QUEUE_SEND_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await queue.send(message);
      return;
    } catch (err) {
      lastError = err;
      const transient = isCloudflareQueueInternalError(err) || isCloudflareQueueOverloadError(err);
      if (!transient || attempt === QUEUE_SEND_RETRY_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, QUEUE_SEND_RETRY_BASE_MS * attempt));
    }
  }
  throw lastError;
}

function queueForShard(env: Env, shard: number): Queue<QueueMessage> {
  const map: Queue<QueueMessage>[] = [
    env.QUEUE_EVENTS_00, env.QUEUE_EVENTS_01, env.QUEUE_EVENTS_02, env.QUEUE_EVENTS_03,
    env.QUEUE_EVENTS_04, env.QUEUE_EVENTS_05, env.QUEUE_EVENTS_06, env.QUEUE_EVENTS_07,
    env.QUEUE_EVENTS_08, env.QUEUE_EVENTS_09, env.QUEUE_EVENTS_10, env.QUEUE_EVENTS_11,
    env.QUEUE_EVENTS_12, env.QUEUE_EVENTS_13, env.QUEUE_EVENTS_14, env.QUEUE_EVENTS_15,
  ];
  const q = map[shard];
  if (!q) throw new Error(`no queue binding for shard ${shard}`);
  return q;
}

/**
 * Resolve the plan cache binding. Returns null when no KV is
 * configured (dev mode without an emulated KV); the gate check
 * treats null as "accept" so local dev still ingests.
 */
function planCacheFor(env: Env): PlanCache | null {
  return env.__PLAN_CACHE_OVERRIDE
    ?? (env.SOURCE_CACHE ? kvPlanCache(env.SOURCE_CACHE) : null);
}

export async function lookupSourceUncached(env: Env, sourceId: string): Promise<Source | null> {
  if (env.DEV_MODE === "true" && env.DEV_SOURCES) {
    try {
      const parsed = JSON.parse(env.DEV_SOURCES) as Record<string, Omit<Source, "source_id">>;
      const entry = parsed[sourceId];
      if (!entry) return null;
      return { source_id: sourceId, ...entry };
    } catch {
      return null;
    }
  }
  // Production: delivery-service owns the reliable Postgres connection and
  // decrypts source signing secrets before returning the edge Source shape.
  // Only its explicit `{ source: null }` response is cacheable as a miss;
  // network/auth/5xx/bad-payload failures throw and become transient 503s.
  if (
    env.DELIVERY_SERVICE_URL
    && (env.SOURCE_LOOKUP_SHARED_SECRET || env.DELIVERY_SHARED_SECRET)
  ) {
    return lookupSourceFromDeliveryService(env, sourceId);
  }

  // Direct Postgres lookup is intentionally local-dev only. Keeping it here is
  // useful for an engineer running the worker against a local control plane,
  // but production must never silently fall back to the unreliable CF→PG path.
  if (env.DEV_MODE === "true") {
    return env.DATABASE_URL ? lookupSourceInPostgres(env, sourceId) : null;
  }
  throw new SourceLookupUnavailableError(
    "delivery-service source lookup is not configured",
  );
}

// Secret-bearing headers excluded even from the request-local derivation map.
// No values from this map are persisted or propagated. x-axel-token is the
// source credential already validated before collection; the rest are generic
// auth carriers. Keys arrive lowercased from the Headers iterator.
const REDACTED_INBOUND_HEADERS = new Set([
  "x-axel-token",
  "authorization",
  "proxy-authorization",
  "cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-authorization",
  "cf-access-jwt-assertion",
  "stripe-signature",
  "x-hub-signature",
  "x-hub-signature-256",
  "x-shopify-hmac-sha256",
  "x-axel-signature",
]);

const REDACTED_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "client_secret",
  "api_key",
  "api-key",
  "apikey",
  "key",
  "secret",
  "private_key",
  "signature",
  "sig",
  "jwt",
  "code",
  "auth",
  "bearer",
  "authorization",
  "credential",
  "password",
]);

const SECRET_NAME_PART = /(^|[-_])(authorization|cookie|credential|jwt|password|secret|signature|token)([-_]|$)|(^|[-_])api[-_]?key([-_]|$)/;

function hasSecretBearingName(name: string): boolean {
  return SECRET_NAME_PART.test(name.toLowerCase());
}

function collectVerificationHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function collectHeaders(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (REDACTED_INBOUND_HEADERS.has(lower) || hasSecretBearingName(lower)) return;
    out[key] = value;
  });
  return out;
}

function collectQuery(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (
      REDACTED_QUERY_KEYS.has(lower)
      || hasSecretBearingName(lower)
      || lower.startsWith("x-amz-")
      || lower.startsWith("x-goog-")
    ) return;
    out[key] = value;
  });
  return out;
}

function boundedProviderEventType(value: string): string {
  const candidate = value.trim();
  return /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/.test(candidate) ? candidate : "";
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function deterministicProviderEventId(
  sourceId: string,
  provider: NonNullable<Source["provider"]>,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<string | null> {
  const identity = await providerReplayIdentity(provider, body, headers);
  if (!identity) return null;
  const fingerprint = await sha256Hex(`${sourceId}\0${provider}\0${identity}`);
  return uuidV8FromSha256(fingerprint);
}

async function providerReplayIdentity(
  provider: NonNullable<Source["provider"]>,
  body: Uint8Array,
  headers: Record<string, string>,
): Promise<string | null> {
  switch (provider) {
    case "github":
      return boundedHeader(headers, "x-github-delivery")
        ?? boundedHeader(headers, "x-hub-signature-256");
    case "shopify":
      return boundedHeader(headers, "x-shopify-webhook-id")
        ?? boundedHeader(headers, "x-shopify-hmac-sha256");
    case "chargebee": {
      const eventId = topLevelJsonId(body);
      return eventId ? `event:${eventId}` : `body:${await sha256BytesHex(body)}`;
    }
    case "stripe": {
      const eventId = topLevelJsonId(body);
      return eventId ? `event:${eventId}` : boundedHeader(headers, "stripe-signature");
    }
    case "custom":
      return boundedHeader(headers, "x-axel-signature");
    default:
      return null;
  }
}

function boundedHeader(headers: Record<string, string>, name: string): string | null {
  const value = headers[name]?.trim();
  return value && value.length <= 2_048 ? `header:${value}` : null;
}

function topLevelJsonId(body: Uint8Array): string | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).id;
    if (typeof value === "string" && value.length > 0 && value.length <= 512) return value;
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    return null;
  } catch {
    return null;
  }
}

async function sha256BytesHex(input: Uint8Array): Promise<string> {
  // Copy into an owned ArrayBuffer. Root TypeScript builds include DOM's
  // stricter BufferSource generic, which rejects a view backed by
  // SharedArrayBuffer even though the Workers runtime accepts Uint8Array.
  const owned = new Uint8Array(input.byteLength);
  owned.set(input);
  const buf = await crypto.subtle.digest("SHA-256", owned.buffer);
  return bytesToHex(new Uint8Array(buf));
}

function uuidV8FromSha256(hexDigest: string): string {
  const chars = hexDigest.slice(0, 32).split("");
  chars[12] = "8";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(value)
    && Number.isFinite(Date.parse(value));
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(buf));
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function json(payload: unknown, status: number, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function uuidv7(): string {
  const ms = BigInt(Date.now());
  const rand = crypto.getRandomValues(new Uint8Array(10));
  const tsHi = Number((ms >> 16n) & 0xffffffffn);
  const tsLo = Number(ms & 0xffffn);
  const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");
  const b0 = hex(tsHi, 8);
  const b1 = hex(tsLo, 4);
  const b2 = ((0x7000 | (rand[0]! << 4) | (rand[1]! >> 4)) & 0xffff).toString(16).padStart(4, "0");
  const b3 = ((0x8000 | (((rand[1]! & 0x0f) << 8) | rand[2]!)) & 0xffff).toString(16).padStart(4, "0");
  const tail = Array.from(rand.slice(3, 9)).map((b) => hex(b, 2)).join("");
  return `${b0}-${b1}-${b2}-${b3}-${tail}`;
}
