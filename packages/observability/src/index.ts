export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  VERCEL_ENV?: string;
  VERCEL_GIT_COMMIT_SHA?: string;
  RENDER_GIT_COMMIT?: string;
  CF_VERSION_METADATA?: string | {
    id: string;
    tag?: string;
    timestamp?: string;
  };
}

export interface SentryClientOptions {
  dsn: string;
  service: string;
  environment?: string;
  release?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Hard deadline for each envelope request. Default 10 seconds. */
  timeoutMs?: number;
}

export interface CaptureContext {
  level?: "error" | "fatal" | "warning" | "info";
  /** Explicit Sentry grouping key. Keep every part operator-defined. */
  fingerprint?: readonly string[];
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
  user?: {
    id?: string;
    username?: string;
    email?: string;
    ip_address?: string;
  };
}

export interface CaptureTransactionInput {
  name: string;
  op: string;
  status?: string;
  tags?: CaptureContext["tags"];
  extra?: CaptureContext["extra"];
}

export interface SentryClient {
  captureException(error: unknown, context?: CaptureContext): Promise<void>;
  captureMessage(message: string, context?: CaptureContext): Promise<void>;
  /**
   * Send a tracing transaction directly through the envelope transport.
   * Unlike the best-effort capture helpers below, this rejects on transport
   * failure so an authenticated production smoke test can fail closed.
   */
  captureTransaction(input: CaptureTransactionInput): Promise<void>;
  captureCheckIn(input: CronCheckInInput): Promise<string>;
}

export type OperationalAlertSeverity = "info" | "warn" | "critical";

export interface OperationalAlertSentryIdentity {
  message: string;
  fingerprint: readonly ["operational_alert", string, string, OperationalAlertSeverity];
}

/**
 * Give each operational alert source, rule, and severity its own Sentry Issue.
 * In particular, a warning must not create the Issue that a later critical
 * event would otherwise join.
 */
export function operationalAlertSentryIdentity(input: {
  source: string;
  rule: string;
  severity: OperationalAlertSeverity;
}): OperationalAlertSentryIdentity {
  return {
    message: `operational_alert:${input.source}:${input.rule}:${input.severity}`,
    fingerprint: ["operational_alert", input.source, input.rule, input.severity],
  };
}

export interface CronMonitorConfig {
  schedule:
    | { type: "crontab"; value: string }
    | { type: "interval"; value: number; unit: "minute" | "hour" | "day" };
  /** Minutes after scheduled time before a missing check-in is considered missed. */
  checkin_margin?: number;
  /** Minutes a single run can take before being marked failed. */
  max_runtime?: number;
  /** IANA tz name; defaults to UTC server-side. */
  timezone?: string;
  failure_issue_threshold?: number;
  recovery_threshold?: number;
}

export interface CronCheckInInput {
  monitor_slug: string;
  status: "in_progress" | "ok" | "error";
  /** Pass the id returned from a prior `in_progress` check-in to close it out. */
  check_in_id?: string;
  /** Run duration in seconds. */
  duration?: number;
  /** First call only — provisions or updates the monitor server-side. */
  monitor_config?: CronMonitorConfig;
  environment?: string;
  release?: string;
}

interface ParsedDsn {
  projectId: string;
  publicKey: string;
  envelopeUrl: string;
}

export function createSentryClient(options: SentryClientOptions): SentryClient {
  const parsed = parseDsn(options.dsn);
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const configuredTimeoutMs = options.timeoutMs;
  const timeoutMs = typeof configuredTimeoutMs === "number" && Number.isFinite(configuredTimeoutMs)
    ? Math.max(1, configuredTimeoutMs)
    : 10_000;

  async function sendEnvelope(
    envelopeHeader: Record<string, unknown>,
    itemHeader: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope = `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}\n`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("sentry_send_timeout"));
      }, timeoutMs);
    });
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(parsed.envelopeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/x-sentry-envelope",
            "x-sentry-auth": [
              "Sentry sentry_version=7",
              `sentry_client=axel-observability/0.1`,
              `sentry_key=${parsed.publicKey}`,
            ].join(", "),
          },
          body: envelope,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("sentry_send_timeout");
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!response.ok) {
      throw new Error(`sentry_send_failed status=${response.status}`);
    }
  }

  async function sendEvent(
    event: Record<string, unknown>,
    itemType: "event" | "transaction" = "event",
    eventTimestamp = now().toISOString(),
  ): Promise<void> {
    const eventId = crypto.randomUUID().replaceAll("-", "");
    const { tags: eventTags, ...eventPayload } = event;
    await sendEnvelope(
      {
        event_id: eventId,
        dsn: options.dsn,
        sent_at: eventTimestamp,
      },
      { type: itemType },
      {
        event_id: eventId,
        timestamp: eventTimestamp,
        platform: "javascript",
        server_name: safeSentrySlug(options.service, "service"),
        environment: optionalSafeSentrySlug(options.environment),
        release: optionalSafeSentrySlug(options.release),
        tags: {
          service: safeSentrySlug(options.service, "service"),
          ...(isRecord(eventTags) ? eventTags : {}),
        },
        ...eventPayload,
      },
    );
  }

  async function sendCheckIn(input: CronCheckInInput): Promise<string> {
    const envelopeEventId = crypto.randomUUID().replaceAll("-", "");
    const checkInId = input.check_in_id ?? crypto.randomUUID().replaceAll("-", "");
    const timestamp = now().toISOString();
    const payload: Record<string, unknown> = {
      check_in_id: checkInId,
      monitor_slug: input.monitor_slug,
      status: input.status,
    };
    const environment = input.environment ?? options.environment;
    if (environment) payload.environment = environment;
    const release = input.release ?? options.release;
    if (release) payload.release = release;
    if (input.duration !== undefined) payload.duration = input.duration;
    if (input.monitor_config) payload.monitor_config = input.monitor_config;
    await sendEnvelope(
      {
        event_id: envelopeEventId,
        dsn: options.dsn,
        sent_at: timestamp,
      },
      { type: "check_in" },
      payload,
    );
    return checkInId;
  }

  return {
    async captureException(error, context) {
      await sendEvent({
        level: context?.level ?? "error",
        fingerprint: sanitizeSentryFingerprint(context?.fingerprint),
        exception: {
          values: [exceptionValue(error)],
        },
        tags: sanitizeSentryTags(context?.tags),
        extra: sanitizeSentryValue(context?.extra),
        // User identity is never required to diagnose a backend exception. Drop
        // the whole object so a future caller cannot bypass the value scrubber
        // with `id`, `email`, `username`, or `ip_address`.
        user: undefined,
      });
    },
    async captureMessage(message, context) {
      await sendEvent({
        level: context?.level ?? "info",
        fingerprint: sanitizeSentryFingerprint(context?.fingerprint),
        message: sentryMessageCode(message),
        tags: sanitizeSentryTags(context?.tags),
        extra: sanitizeSentryValue(context?.extra),
        user: undefined,
      });
    },
    async captureTransaction(input) {
      const timestamp = now().toISOString();
      await sendEvent(
        {
          type: "transaction",
          transaction: safeSentrySlug(input.name, "application_transaction"),
          transaction_info: { source: "custom" },
          start_timestamp: timestamp,
          contexts: {
            trace: {
              trace_id: crypto.randomUUID().replaceAll("-", ""),
              span_id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
              op: safeSentrySlug(input.op, "custom"),
              status: safeSentrySlug(input.status ?? "ok", "unknown"),
            },
          },
          spans: [],
          tags: sanitizeSentryTags(input.tags),
          extra: sanitizeSentryValue(input.extra),
        },
        "transaction",
        timestamp,
      );
    },
    async captureCheckIn(input) {
      return await sendCheckIn(input);
    },
  };
}

export function sentryClientFromEnv(
  env: SentryEnv | Record<string, string | undefined>,
  service: string,
  options: { fetchImpl?: typeof fetch } = {},
): SentryClient | null {
  if (!env.SENTRY_DSN) return null;
  return createSentryClient({
    dsn: env.SENTRY_DSN,
    service,
    ...optionalString("environment", env.SENTRY_ENVIRONMENT ?? env.VERCEL_ENV),
    ...optionalString(
      "release",
      env.SENTRY_RELEASE
        ?? env.VERCEL_GIT_COMMIT_SHA
        ?? env.RENDER_GIT_COMMIT
        ?? cloudflareRelease(env.CF_VERSION_METADATA),
    ),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
}

/**
 * AXE-65 — detect Cloudflare Queues backpressure errors.
 *
 * Cloudflare Queues rate-limits producers (~5000 msg/s per queue) and
 * returns "Queue is overloaded. Please back off. (10250)" both from
 * the native `Queue<T>.send()` binding (thrown as Error) and from the
 * HTTP API (as `{success: false, errors: [{code: 10250}]}`). This is
 * by definition transient — the right response is to back off, not
 * to file a code bug.
 *
 * Callers should:
 *   - skip Sentry capture when this returns true
 *   - let Cloudflare's at-least-once retry handle re-delivery
 *     (consumer side: `msg.retry()`; producer side: 503 + Retry-After
 *     so the client backs off)
 *
 * Use a duck-typed check rather than `instanceof` because the error
 * crosses runtime boundaries (Workers → Render) where prototype
 * chains don't survive.
 */
export function isCloudflareQueueOverloadError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  // Match the canonical Cloudflare 10250 error in either shape:
  //   - native binding throw: "Queue is overloaded. Please back off. (10250)"
  //   - HTTP API body excerpt: `"code":10250` or `(10250)`
  return /\b10250\b/.test(message) || /Queue is overloaded/i.test(message);
}

/**
 * Detect Cloudflare Queue's transient platform failure (code 15000).
 *
 * Unlike 10250 backpressure, this is an internal Queue service error. Producer
 * callers should retry the SAME message/event id in-process a small number of
 * times, then return 503 so the upstream producer can retry. Reusing the event
 * id is important because Queue delivery is at-least-once and downstream
 * idempotency keys are derived from it.
 */
export function isCloudflareQueueInternalError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  return /unknown internal error\s*\(15000\)/i.test(message) ||
    /["']?code["']?\s*:\s*15000\b/i.test(message);
}

/**
 * AXE-93 — detect "circuit breaker open" responses from the delivery
 * service.
 *
 * The destination-level circuit breaker (apps/delivery-service) replies
 * 503 with `{"skipped_by":"circuit_breaker","reason":"breaker_open_cooldown_active"}`
 * when a destination has hit its failure threshold. The router-edge
 * surfaces this as `delivery_service_503: ...` so the queue message
 * retries. That retry is the right behaviour — the breaker will close on
 * its own once the cooldown elapses — but the throw used to also light
 * up Sentry on every router tick, which is noise: the breaker is doing
 * its job. Callers should skip Sentry capture (until final attempt)
 * when this returns true, exactly like AXE-65's queue-overload path.
 */
export function isCircuitBreakerOpenError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  return (
    /breaker_open_cooldown_active/i.test(message) ||
    (/skipped_by/i.test(message) && /circuit_breaker/i.test(message))
  );
}

/**
 * AXE-95..113 — detect transient Postgres connectivity errors.
 *
 * Managed Postgres providers (Supabase, Render, Neon) cycle their poolers
 * and database instances regularly for maintenance and failover. During
 * those windows, pooled connections die mid-flight and new connections
 * are refused for a few seconds. We surface those failures from `pg` as:
 *
 *   - ECONNREFUSED  — pooler is restarting, not yet accepting connections
 *   - ECONNRESET    — connection killed mid-query during pooler restart
 *   - ECONNABORTED  — TLS socket aborted while an idle pooled connection closes
 *   - ETIMEDOUT     — direct TCP dial timed out before the pooler answered
 *   - "Connection terminated unexpectedly"
 *   - "Connection terminated due to connection timeout"
 *   - "timeout exceeded when trying to connect"  — pool acquire timed out
 *   - "the database system is starting up"        — Postgres just booted
 *   - "the database system is not yet accepting connections"
 *   - "server closed the connection unexpectedly"
 *   - "connection ended"                          — pg client side-effect
 *
 * These are operational noise, not code bugs. Caught failures should skip
 * Sentry capture and let the at-least-once retry (pg pool re-acquire, queue
 * redelivery) handle the reconnection. A failure that escapes to the Node
 * process boundary is different: the process is no longer safe to continue,
 * so the fatal handler captures it once (tagged as transient), flushes, and
 * exits for the platform supervisor to restart.
 *
 * Used by:
 *   - `installNodeSentryHandlers` to classify process-fatal pg failures
 *   - callers around `pool.query` to gate manual `captureException`
 *   - `withPgRetry`-style helpers as the canonical "should we retry?"
 *     predicate so the list lives in one place
 */
export function isTransientPostgresError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  return (
    /econnrefused/i.test(message) ||
    /econnreset/i.test(message) ||
    /econnaborted/i.test(message) ||
    /\betimedout\b/i.test(message) ||
    /connection terminated/i.test(message) ||
    /connection ended/i.test(message) ||
    /connect_timeout/i.test(message) ||
    /connection_closed/i.test(message) ||
    /proxy request failed, cannot connect to the specified address/i.test(message) ||
    /server closed/i.test(message) ||
    /timeout exceeded when trying to connect/i.test(message) ||
    /the database system is (starting up|not yet accepting connections|shutting down)/i.test(message)
  );
}

/**
 * A `pg.Pool` ACQUIRE timeout — "timeout exceeded when trying to connect" —
 * meaning every pooled connection was busy for the full `connectionTimeoutMillis`
 * window. This is a SATURATION signal, distinct from a connection blip
 * (ECONNREFUSED/ECONNRESET) where a fresh connection would succeed immediately.
 *
 * It is still a transient error for Sentry-drop / queue-redelivery purposes
 * (kept in `isTransientPostgresError`), but `withPgRetry` must NOT retry it
 * in-process: an immediate re-acquire against the same exhausted pool just
 * re-queues demand and DEEPENS a connection storm (see the 10M/day scaling
 * analysis — this feedback loop turned a brownout into the 2026-06 cascade).
 * Shed instead and let queue redelivery reconnect with backoff.
 */
export function isPoolAcquireTimeout(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "");
  return /timeout exceeded when trying to connect/i.test(message);
}

/**
 * Run a `pg.Pool` query (or any pg-backed operation) with one transient-error
 * retry. Catches the canonical pooler-blip errors (see `isTransientPostgresError`),
 * pauses briefly so the pool can hand back a fresh connection, and retries
 * once. Anything that isn't transient propagates immediately.
 *
 * Canonical wrapper used by delivery-service and pull-worker so a single
 * managed-Postgres failover doesn't turn into a Sentry fingerprint or a
 * dropped tick.
 */
export async function withPgRetry<T>(
  _label: string,
  fn: () => Promise<T>,
  options: { backoffMs?: number } = {},
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // Fail FAST on a pool-acquire timeout: the pool is saturated, so an
    // in-process retry after a short sleep just re-acquires against the same
    // exhausted pool and amplifies a connection storm. Shed and let the caller
    // (queue redelivery with backoff) reconnect later.
    if (isPoolAcquireTimeout(err)) {
      console.warn("[pg-retry] pool_acquire_timeout");
      throw err;
    }
    if (isTransientPostgresError(err)) {
      console.warn("[pg-retry] transient_retry");
      await new Promise((resolve) => setTimeout(resolve, options.backoffMs ?? 100));
      return await fn();
    }
    throw err;
  }
}

/**
 * Detect transient platform/network fetch failures.
 *
 * Node 18+ and Workers often collapse DNS resets, socket resets, and aborted
 * platform fetches into the unhelpful top-level `TypeError: fetch failed`.
 * Use this only around infrastructure calls that already have a retry loop
 * (Cloudflare Queue pull/ack, heartbeat probes, etc.). Customer destination
 * delivery failures should remain delivery attempts, not Sentry events.
 */
export function isTransientFetchError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  return (
    /fetch failed/i.test(message) ||
    /network error/i.test(message) ||
    /socket hang up/i.test(message) ||
    /econnreset/i.test(message) ||
    /etimedout/i.test(message) ||
    /\bAbortError\b/i.test(message) ||
    /\b(?:this|the) operation was aborted\b/i.test(message) ||
    // The Workers runtime's wording when a subrequest connection drops
    // mid-flight — the Workers-side equivalent of ECONNRESET. Cloudflare
    // re-delivers the queue message, so it needs no Sentry issue
    // (JAVASCRIPT-2N).
    /\bnetwork connection lost\b/i.test(message) ||
    /und_err_/i.test(message)
  );
}

/**
 * Detect transient HTTP responses from platform APIs that are already
 * retried by their caller.
 *
 * Keep this narrower than a generic `HTTP 500` matcher: application 5xx
 * responses can be real bugs. The current production shape is Cloudflare's
 * Queue/R2/ClickHouse API returning a 500-ish platform response body.
 */
export function isTransientPlatformHttpError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  // A query timeout is transient — the client aborted a slow query and the
  // caller retries (e.g. the data-contracts-drift cron on its next 5-min tick).
  // These carry no HTTP status, so match before the status gate below.
  if (/\bquery timed out after \d+\s*ms\b/i.test(message)) return true;
  // Cloudflare's edge-error family (520–527, 530) means its edge could not
  // reach the origin — 521 "Web Server Is Down", 524 "A Timeout Occurred",
  // and so on. Only the Cloudflare edge emits these, so the status alone
  // settles it and we skip the response-body gate below: the body is an HTML
  // error page, not a JSON API error (JAVASCRIPT-38).
  if (/\b(?:HTTP\s+|r2_(?:get|put|delete)_)(?:52[0-7]|530)\b/i.test(message)) return true;
  const status = /\bHTTP\s+(500|502|503|504)\b/i.exec(message)
    ?? /\br2_(?:get|put|delete)_(500|502|503|504)\b/i.exec(message)
    ?? /\bClickHouse query failed \((500|502|503|504)\)/i.exec(message);
  if (!status) return false;
  return (
    /unknown internal error/i.test(message) ||
    /internal server error/i.test(message) ||
    /bad gateway/i.test(message) ||
    /service unavailable/i.test(message) ||
    /gateway timeout/i.test(message) ||
    /clickhouse query failed/i.test(message) ||
    /\/opt\/render\//i.test(message) ||
    /cloudflare/i.test(message)
  );
}

/**
 * Detect transient Cloudflare R2 errors.
 *
 * R2 returns a 5xx-equivalent with the literal "Please try again." copy
 * for transient internal failures (10001 and adjacent codes). Tell the
 * client to retry instead of opening a Sentry fingerprint per blip.
 *
 * Canonical shapes:
 * - `Error: put: We encountered an internal error. Please try again. (10001)`
 * - `Error: put: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)`
 * - `Error: put: Reduce your concurrent request rate for the same object. (10058)`
 * - `Error: r2_get_truncated (65536/131072 bytes)`
 */
export function isTransientR2Error(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  if (!message) return false;
  return /\br2_(?:get|put|delete)_429\b/i.test(message) ||
    // A body shorter than its own content-length: the response stream was cut.
    // The reader raises this instead of handing short bytes to a parser.
    /\br2_get_truncated\b/i.test(message) ||
    /we encountered an internal error\. please try again/i.test(message) ||
    /please look at https:\/\/www\.cloudflarestatus\.com for issues or contact customer support\. \(10043\)/i
      .test(message) ||
    /reduce your concurrent request rate for the same object\. \(10058\)/i.test(message) ||
    /reduce your rate of simultaneous reads on the same object\. \(10058\)/i.test(message);
}

export * from "./heartbeat";

/** Maximum time a crashing process waits for Sentry's envelope transport. */
export const NODE_SENTRY_EXIT_FLUSH_TIMEOUT_MS = 2_000;

const nodeSentryHandlerProcesses = new WeakSet<object>();

/**
 * Capture a fatal exception and wait for the custom transport to finish, but
 * never hold process shutdown open indefinitely. `SentryClient.captureException`
 * resolves only after the envelope endpoint accepts the request, so this is the
 * flush boundary for the lightweight client.
 */
export async function captureExceptionBeforeExit(
  client: SentryClient | null,
  error: unknown,
  context?: CaptureContext,
  timeoutMs = NODE_SENTRY_EXIT_FLUSH_TIMEOUT_MS,
): Promise<void> {
  if (!client) return;

  const boundedTimeoutMs = Number.isFinite(timeoutMs)
    ? Math.max(0, timeoutMs)
    : NODE_SENTRY_EXIT_FLUSH_TIMEOUT_MS;
  let timedOut = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const capture = Promise.resolve()
    .then(() => client.captureException(error, context))
    .catch(() => console.error("[sentry] capture failed"));
  const deadline = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      timedOut = true;
      resolve();
    }, boundedTimeoutMs);
  });

  await Promise.race([capture, deadline]);
  if (timeout) clearTimeout(timeout);
  if (timedOut) {
    console.error(`[sentry] fatal capture timed out after ${boundedTimeoutMs}ms`);
  }
}

export function installNodeSentryHandlers(
  client: SentryClient | null,
  options: { flushTimeoutMs?: number } = {},
): void {
  const maybeProcess = (globalThis as {
    process?: {
      on?: (event: "uncaughtException" | "unhandledRejection", handler: (reason: unknown) => void) => void;
      exit?: (code: number) => never;
    };
  }).process;
  if (!client || typeof maybeProcess?.on !== "function" || typeof maybeProcess.exit !== "function") return;

  // Next.js instrumentation and test harnesses can call registration more than
  // once in a process. Multiple listeners would send duplicate fatal events.
  if (nodeSentryHandlerProcesses.has(maybeProcess)) return;
  nodeSentryHandlerProcesses.add(maybeProcess);

  let terminating = false;
  const terminate = (reason: unknown, kind: "uncaughtException" | "unhandledRejection"): void => {
    // A second fatal signal can arrive while the first envelope is flushing.
    // The process is already committed to exit; capture exactly one root cause.
    if (terminating) return;
    terminating = true;
    console.error(`[fatal] ${kind}`);
    const transientPostgres = isTransientPostgresError(reason);
    void captureExceptionBeforeExit(
      client,
      reason,
      {
        level: "fatal",
        tags: {
          unhandled: true,
          kind,
          ...(transientPostgres ? { category: "transient_postgres" } : {}),
        },
      },
      options.flushTimeoutMs,
    ).then(
      () => maybeProcess.exit?.(1),
      () => {
        // Defensive fallback: the helper is designed not to reject, but no
        // observability failure may leave a corrupted process running.
        console.error("[sentry] fatal handler failed");
        maybeProcess.exit?.(1);
      },
    );
  };

  maybeProcess.on("uncaughtException", (err: unknown) => terminate(err, "uncaughtException"));
  maybeProcess.on("unhandledRejection", (reason: unknown) => terminate(reason, "unhandledRejection"));
}

export async function captureException(
  client: SentryClient | null,
  error: unknown,
  context?: CaptureContext,
): Promise<void> {
  if (!client) return;
  try {
    await client.captureException(error, context);
  } catch {
    console.error("[sentry] capture failed");
  }
}

export async function captureCheckIn(
  client: SentryClient | null,
  input: CronCheckInInput,
): Promise<string | null> {
  if (!client) return null;
  try {
    return await client.captureCheckIn(input);
  } catch {
    console.error("[sentry] check-in failed");
    return null;
  }
}

/**
 * Wrap a cron job body with Sentry check-in lifecycle reporting.
 *
 * Sends an `in_progress` check-in before the body runs, then `ok` or `error`
 * after with the actual duration. Returns whatever `fn` returns. No-ops
 * gracefully when sentry is null (dev / DSN unset). Errors from the check-in
 * sender are swallowed — the wrapped job is the source of truth.
 */
export async function withCronCheckIn<T>(
  sentry: SentryClient | null,
  options: { slug: string; monitorConfig?: CronMonitorConfig },
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const checkInId = await captureCheckIn(sentry, {
    monitor_slug: options.slug,
    status: "in_progress",
    ...(options.monitorConfig ? { monitor_config: options.monitorConfig } : {}),
  });
  try {
    const result = await fn();
    if (checkInId) {
      await captureCheckIn(sentry, {
        monitor_slug: options.slug,
        status: "ok",
        check_in_id: checkInId,
        duration: (Date.now() - startedAt) / 1000,
      });
    }
    return result;
  } catch (err) {
    if (checkInId) {
      await captureCheckIn(sentry, {
        monitor_slug: options.slug,
        status: "error",
        check_in_id: checkInId,
        duration: (Date.now() - startedAt) / 1000,
      });
    }
    throw err;
  }
}

function parseDsn(dsn: string): ParsedDsn {
  const url = new URL(dsn);
  const projectId = url.pathname.split("/").filter(Boolean).at(-1);
  if (!projectId || !url.username) {
    throw new Error("invalid SENTRY_DSN");
  }
  const basePath = url.pathname.slice(0, -projectId.length).replace(/\/$/, "");
  const envelopeUrl = `${url.protocol}//${url.host}${basePath}/api/${projectId}/envelope/`;
  return {
    projectId,
    publicKey: url.username,
    envelopeUrl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalString<K extends string>(key: K, value: string | undefined): { [P in K]: string } | Record<string, never> {
  return value ? { [key]: value } as { [P in K]: string } : {};
}

function cloudflareRelease(metadata: SentryEnv["CF_VERSION_METADATA"]): string | undefined {
  if (typeof metadata === "string") return metadata || undefined;
  return metadata?.tag || metadata?.id;
}

function exceptionValue(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      type: safeExceptionType(error.name),
      value: sentryErrorCode(error),
      stacktrace: {
        frames: stackFrames(error.stack),
      },
    };
  }
  return {
    type: "Error",
    value: sentryErrorCode(error),
  };
}

const SAFE_EXCEPTION_TYPES = new Set([
  "AggregateError",
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function safeExceptionType(value: string): string {
  return SAFE_EXCEPTION_TYPES.has(value) ? value : "Error";
}

function sentryErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === "SourceLookupUnavailableError") {
    const reason = (error as Error & { reason?: unknown }).reason;
    if (typeof reason === "string" && SOURCE_LOOKUP_DIAGNOSTIC_REASONS.has(reason)) {
      return `source_lookup_${reason}`;
    }
  }
  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";

  const alert = /^operational_alert:([a-z0-9_-]{1,64}):([a-z0-9_-]{1,64}):(info|warn|critical)$/u
    .exec(message);
  if (alert) return alert[0];
  if (message === "destination_queue_message_invalid") {
    return "destination_queue_message_invalid";
  }
  if (isCloudflareQueueOverloadError(error)) return "cloudflare_queue_overloaded";
  if (isCloudflareQueueInternalError(error)) return "cloudflare_queue_internal";
  if (isCircuitBreakerOpenError(error)) return "circuit_breaker_open";
  if (isPoolAcquireTimeout(error)) return "postgres_pool_acquire_timeout";
  if (isTransientPostgresError(error)) return "transient_postgres";
  if (isTransientR2Error(error)) return "transient_r2";
  if (isTransientFetchError(error)) return "transient_fetch";
  if (isTransientPlatformHttpError(error)) return "transient_platform_http";

  const status = /\b(?:HTTP\s+|[a-z0-9_-]+_)([1-5][0-9]{2})\b/iu.exec(message)?.[1];
  return status ? `http_error_${status}` : "application_error";
}

function sentryMessageCode(message: string): string {
  if (message === "Destination queue message failed runtime validation") {
    return "destination_queue_message_invalid";
  }
  if (message === "Direct delivery message failed runtime validation") {
    return "direct_delivery_message_invalid";
  }
  return "application_message";
}

const SENTRY_SECRET_KEY_RE =
  /(?:authorization|body|cookie|credential|password|payload|raw|secret|signature|token|api[_-]?key)/i;
const SENTRY_IDENTIFIER_KEY_RE =
  /^(?:attempt|credential|customer|destination|event|replay|route|source|user|workspace)[_-]?id$/i;

function sanitizeSentryValue(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  // Free-form strings can contain webhook values, provider responses, or
  // identifiers under an innocuous key. Operational extras are metrics only.
  if (typeof value === "string") return undefined;
  if (depth >= 8) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 32)
      .map((item) => sanitizeSentryValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (typeof value !== "object") return undefined;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 64)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/iu.test(key)) continue;
    if (SENTRY_SECRET_KEY_RE.test(key) || SENTRY_IDENTIFIER_KEY_RE.test(key)) continue;
    const sanitized = sanitizeSentryValue(child, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const SENTRY_ALLOWED_TAG_KEYS = new Set([
  "alert_rule",
  "alert_severity",
  "alert_source",
  "category",
  "component",
  "controlled_probe",
  "error_code",
  "field",
  "final_attempt",
  "http_status",
  "kind",
  "phase",
  "reason",
  "retryable",
  "severity",
  "status",
  "unhandled",
]);

function sanitizeSentryTags(
  tags: Record<string, string | number | boolean | null | undefined> | undefined,
): Record<string, string | number | boolean | null | undefined> | undefined {
  if (!tags) return undefined;
  const sanitized: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(tags).slice(0, 64)) {
    if (!SENTRY_ALLOWED_TAG_KEYS.has(key)) continue;
    if (typeof value === "string") {
      sanitized[key] = safeSentrySlug(value, "redacted");
    } else if (typeof value === "number") {
      if (Number.isFinite(value)) sanitized[key] = value;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// Only engine-defined reasons may distinguish these issues. Never group on a
// source identifier, provider response, or the original exception message.
const SOURCE_LOOKUP_DIAGNOSTIC_REASONS = new Set([
  "lookup_failed", "lookup_not_configured", "lookup_timeout", "lookup_network",
  "lookup_http", "lookup_invalid_response", "authority_unavailable", "source_fenced", "authorization_changed",
]);

function sanitizeSentryFingerprint(fingerprint: readonly string[] | undefined): string[] | undefined {
  if (!fingerprint) return undefined;
  if (fingerprint.length === 2 && fingerprint[0] === "source_lookup"
      && SOURCE_LOOKUP_DIAGNOSTIC_REASONS.has(fingerprint[1]!)) return [...fingerprint];
  if (fingerprint.length !== 4 || fingerprint[0] !== "operational_alert") {
    return ["application_error"];
  }
  return fingerprint.map((part) => safeSentrySlug(part, "redacted"));
}

function safeSentrySlug(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^[a-z0-9][a-z0-9_.:-]{0,95}$/iu.test(trimmed) ? trimmed : fallback;
}

function optionalSafeSentrySlug(value: string | undefined): string | undefined {
  return value === undefined ? undefined : safeSentrySlug(value, "redacted");
}

function stackFrames(stack: string | undefined): Array<Record<string, unknown>> {
  if (!stack) return [];
  return stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .map(parseStackFrame)
    .reverse();
}

function parseStackFrame(line: string): Record<string, unknown> {
  const withoutPrefix = line.startsWith("at ") ? line.slice(3) : line;
  const colSep = withoutPrefix.lastIndexOf(":");
  if (colSep === -1) return { function: "<unknown>" };
  const lineSep = withoutPrefix.lastIndexOf(":", colSep - 1);
  if (lineSep === -1) return { function: "<unknown>" };

  const colno = Number(withoutPrefix.slice(colSep + 1).replace(")", ""));
  const lineno = Number(withoutPrefix.slice(lineSep + 1, colSep));
  if (!Number.isFinite(lineno) || !Number.isFinite(colno)) return { function: "<unknown>" };

  const locationWithMaybeFunction = withoutPrefix.slice(0, lineSep);
  const openParen = locationWithMaybeFunction.lastIndexOf(" (");
  if (openParen === -1) {
    const filename = safeStackFilename(locationWithMaybeFunction);
    return {
      function: "<anonymous>",
      filename,
      lineno,
      colno,
      in_app: isInAppFrame(filename),
    };
  }

  const filename = safeStackFilename(locationWithMaybeFunction.slice(openParen + 2));
  return {
    function: "<anonymous>",
    filename,
    lineno,
    colno,
    in_app: isInAppFrame(filename),
  };
}

function safeStackFilename(filename: string): string {
  const clean = filename.replace(/\)+$/u, "");
  if (/^node:[a-z0-9_./-]{1,160}$/iu.test(clean)) return clean;
  for (const root of ["/apps/", "/packages/"] as const) {
    const index = clean.lastIndexOf(root);
    if (index >= 0) return clean.slice(index + 1, index + 1 + 240);
  }
  if (/^(?:apps|packages)\/[a-z0-9_./@-]{1,230}$/iu.test(clean)) {
    return clean.slice(0, 240);
  }
  return "[external]";
}

function isInAppFrame(filename: string): boolean {
  if (filename.startsWith("node:") || filename.includes("/node_modules/")) return false;
  return filename.startsWith("apps/")
    || filename.startsWith("packages/")
    || filename.includes("/apps/")
    || filename.includes("/packages/");
}
