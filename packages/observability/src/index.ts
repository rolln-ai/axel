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
}

export interface CaptureContext {
  level?: "error" | "fatal" | "warning" | "info";
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

  async function sendEnvelope(
    envelopeHeader: Record<string, unknown>,
    itemHeader: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const envelope = `${JSON.stringify(envelopeHeader)}\n${JSON.stringify(itemHeader)}\n${JSON.stringify(payload)}\n`;
    const response = await fetchImpl(parsed.envelopeUrl, {
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
    });
    if (!response.ok) {
      throw new Error(`sentry_send_failed status=${response.status} project=${parsed.projectId}`);
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
        server_name: options.service,
        environment: options.environment,
        release: options.release,
        tags: {
          service: options.service,
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
        exception: {
          values: [exceptionValue(error)],
        },
        tags: context?.tags,
        extra: context?.extra,
        user: context?.user,
      });
    },
    async captureMessage(message, context) {
      await sendEvent({
        level: context?.level ?? "info",
        message,
        tags: context?.tags,
        extra: context?.extra,
        user: context?.user,
      });
    },
    async captureTransaction(input) {
      const timestamp = now().toISOString();
      await sendEvent(
        {
          type: "transaction",
          transaction: input.name,
          transaction_info: { source: "custom" },
          start_timestamp: timestamp,
          contexts: {
            trace: {
              trace_id: crypto.randomUUID().replaceAll("-", ""),
              span_id: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
              op: input.op,
              status: input.status ?? "ok",
            },
          },
          spans: [],
          tags: input.tags,
          extra: input.extra,
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
  label: string,
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
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pg-retry] pool acquire timeout on ${label} — shedding, no in-process retry: ${message.slice(0, 200)}`);
      throw err;
    }
    if (isTransientPostgresError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[pg-retry] transient on ${label} — retrying once: ${message.slice(0, 200)}`);
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
 * - `Error: r2_get_truncated: queue-spill/… (65536/131072 bytes)`
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
    .catch((captureErr) => console.error("[sentry] capture failed", captureErr));
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
    console.error(`[fatal] ${kind}`, reason);
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
      (captureErr) => {
        // Defensive fallback: the helper is designed not to reject, but no
        // observability failure may leave a corrupted process running.
        console.error("[sentry] fatal handler failed", captureErr);
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
  } catch (captureErr) {
    console.error("[sentry] capture failed", captureErr);
  }
}

export async function captureCheckIn(
  client: SentryClient | null,
  input: CronCheckInInput,
): Promise<string | null> {
  if (!client) return null;
  try {
    return await client.captureCheckIn(input);
  } catch (captureErr) {
    console.error("[sentry] check-in failed", captureErr);
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
      type: error.name,
      value: error.message,
      stacktrace: {
        frames: stackFrames(error.stack),
      },
    };
  }
  return {
    type: typeof error,
    value: String(error),
  };
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
  if (colSep === -1) return { function: withoutPrefix };
  const lineSep = withoutPrefix.lastIndexOf(":", colSep - 1);
  if (lineSep === -1) return { function: withoutPrefix };

  const colno = Number(withoutPrefix.slice(colSep + 1).replace(")", ""));
  const lineno = Number(withoutPrefix.slice(lineSep + 1, colSep));
  if (!Number.isFinite(lineno) || !Number.isFinite(colno)) return { function: withoutPrefix };

  const locationWithMaybeFunction = withoutPrefix.slice(0, lineSep);
  const openParen = locationWithMaybeFunction.lastIndexOf(" (");
  if (openParen === -1) {
    const filename = locationWithMaybeFunction;
    return {
      function: "<anonymous>",
      filename,
      lineno,
      colno,
      in_app: isInAppFrame(filename),
    };
  }

  const filename = locationWithMaybeFunction.slice(openParen + 2);
  return {
    function: locationWithMaybeFunction.slice(0, openParen),
    filename,
    lineno,
    colno,
    in_app: isInAppFrame(filename),
  };
}

function isInAppFrame(filename: string): boolean {
  if (filename.startsWith("node:") || filename.includes("/node_modules/")) return false;
  return filename.includes("/apps/") || filename.includes("/packages/");
}
