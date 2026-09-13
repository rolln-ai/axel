/**
 * Alert client + threshold evaluators.
 *
 * Architecture (`docs/production-scale.md`) lists the alert surfaces every
 * Axel deployment must monitor:
 *   - queue lag
 *   - retry rate
 *   - declarative engine error rate
 *   - dead-letter count
 *   - destination p95 latency
 *   - R2 read/write errors
 *
 * This module gives the router (and any other service) a tiny, vendor-neutral
 * alert client. Operators configure ALERT_WEBHOOK_URL in the environment
 * (Slack, PagerDuty events, Sentry webhook, generic OpsGenie — all accept a
 * JSON POST). Threshold evaluators inspect periodically-collected counters
 * and emit alert events when something crosses a line.
 */

export type AlertSeverity = "info" | "warn" | "critical";

export interface AlertEvent {
  severity: AlertSeverity;
  /** Short slug identifying the rule that triggered. */
  rule: string;
  /** Human-readable single-sentence summary for pagers. */
  summary: string;
  /** Service that emitted the alert. */
  source: string;
  /** Structured details — must be JSON-serialisable. */
  details: Record<string, unknown>;
  /** ISO8601 timestamp when the alert was raised. */
  occurred_at: string;
}

export interface AlertSink {
  notify(event: AlertEvent): Promise<void>;
}

const SAFE_ALERT_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function safeAlertSlug(value: string, fallback: string): string {
  return SAFE_ALERT_SLUG_RE.test(value) ? value : fallback;
}

function safeAlertDetails(
  input: Record<string, unknown>,
  depth = 0,
): Record<string, unknown> {
  if (depth >= 3) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, 32)) {
    if (!SAFE_ALERT_SLUG_RE.test(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      out[key] = value;
    } else if (typeof value === "object" && value && !Array.isArray(value)) {
      const nested = safeAlertDetails(value as Record<string, unknown>, depth + 1);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  return out;
}

/**
 * Enforce the privacy boundary shared by hosted logs, Sentry, and operator
 * webhooks. Callers may accidentally attach exception text, provider
 * responses, tenant identifiers, or webhook-derived strings to an alert; no
 * string value crosses this boundary except validated operational slugs and a
 * generated timestamp.
 */
export function externalAlertEvent(event: AlertEvent): AlertEvent {
  return {
    severity: ["info", "warn", "critical"].includes(event.severity) ? event.severity : "warn",
    rule: safeAlertSlug(event.rule, "unknown_rule"),
    summary: "Operational alert emitted.",
    source: safeAlertSlug(event.source, "unknown_source"),
    details: safeAlertDetails(event.details),
    occurred_at:
      ISO_TIMESTAMP_RE.test(event.occurred_at) && Number.isFinite(Date.parse(event.occurred_at))
        ? event.occurred_at
        : new Date().toISOString(),
  };
}

/** Drops every alert. Useful for tests. */
export function silentAlertSink(): AlertSink {
  return {
    async notify() {
      // intentionally empty
    },
  };
}

/** Forwards alerts to the host process stderr. Useful for local dev. */
export function consoleAlertSink(): AlertSink {
  return {
    async notify(event) {
      const safeEvent = externalAlertEvent(event);
      const tag = safeEvent.severity.toUpperCase();
      console.error(`[alert ${tag}] ${safeEvent.source}/${safeEvent.rule}: alert emitted`);
    },
  };
}

/** Fan out to multiple sinks. Errors in one sink do not block the others. */
export function multiAlertSink(sinks: AlertSink[]): AlertSink {
  return {
    async notify(event) {
      const results = await Promise.allSettled(sinks.map((sink) => sink.notify(event)));
      // Surface aggregated errors via console (so CI tests see them) without
      // throwing — we never want alerting to take the service down.
      for (const result of results) {
        if (result.status === "rejected") {
          console.error("[alert sink] notify failed");
        }
      }
    },
  };
}

/**
 * POST every alert to a webhook URL. Compatible with Slack incoming webhooks,
 * Sentry webhook integrations, generic OpsGenie inbound, and PagerDuty
 * Events API v2.
 *
 * The body shape includes BOTH a `text` field (for Slack-style consumers) and
 * a structured payload, so a single URL works against most receivers.
 */
export interface WebhookAlertSinkOptions {
  url: string;
  /** Override fetch (test injection). */
  fetchImpl?: typeof fetch;
  /** Optional shared secret added as the `X-Axel-Alert-Token` header. */
  token?: string;
  /** Hard timeout per alert post; default 3000ms. */
  timeoutMs?: number;
}

export function webhookAlertSink(options: WebhookAlertSinkOptions): AlertSink {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3000;

  return {
    async notify(event) {
      const safeEvent = externalAlertEvent(event);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          redirect: "manual",
          signal: ac.signal,
          headers: {
            "content-type": "application/json",
            ...(options.token ? { "x-axel-alert-token": options.token } : {}),
          },
          body: JSON.stringify({
            text: `[${safeEvent.severity.toUpperCase()}] ${safeEvent.source}/${safeEvent.rule}: alert emitted`,
            event: safeEvent,
          }),
        });
        if (!response.ok) {
          throw new Error(`alert_webhook_http_${response.status}`);
        }
      } catch {
        // Logged-and-swallowed: alerting must never page the service itself.
        console.error("[alert webhook] post failed");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// --- Threshold evaluators -------------------------------------------------- //

export interface DeliveryWindowSnapshot {
  attempts: number;
  successes: number;
  retries: number;
  dead: number;
  /** Window length in seconds, used for rate calcs. */
  window_seconds: number;
}

export interface AlertThresholds {
  /** Fire when retry rate over the window exceeds this fraction (default 0.10). */
  retry_rate_warn: number;
  /** Fire critical when retry rate exceeds this fraction (default 0.25). */
  retry_rate_critical: number;
  /** Fire when dead-letter count over the window exceeds this absolute (default 50). */
  dead_letter_count_warn: number;
  /** Fire when dead-letter count over the window exceeds this absolute (default 200). */
  dead_letter_count_critical: number;
  /** Fire when queue lag (oldest unacked message age, seconds) exceeds this (default 60). */
  queue_lag_seconds_warn: number;
  /** Fire when queue lag exceeds this (default 300). */
  queue_lag_seconds_critical: number;
  /** Fire when declarative engine error rate over window exceeds this fraction (default 0.05). */
  engine_error_rate_warn: number;
  engine_error_rate_critical: number;
  /** Fire when destination p95 latency exceeds this many ms (default 2000). */
  destination_p95_latency_ms_warn: number;
  /** Fire critical when destination p95 latency exceeds this many ms (default 5000). */
  destination_p95_latency_ms_critical: number;
}

export const DEFAULT_THRESHOLDS: AlertThresholds = {
  retry_rate_warn: 0.10,
  retry_rate_critical: 0.25,
  dead_letter_count_warn: 50,
  dead_letter_count_critical: 200,
  queue_lag_seconds_warn: 60,
  queue_lag_seconds_critical: 300,
  engine_error_rate_warn: 0.05,
  engine_error_rate_critical: 0.20,
  destination_p95_latency_ms_warn: 2000,
  destination_p95_latency_ms_critical: 5000,
};

export function evaluateDeliveryHealth(
  snapshot: DeliveryWindowSnapshot,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
  source = "router",
): AlertEvent[] {
  const out: AlertEvent[] = [];
  const now = new Date().toISOString();
  if (snapshot.attempts === 0) return out;

  const retryRate = snapshot.retries / snapshot.attempts;
  if (retryRate >= thresholds.retry_rate_critical) {
    out.push({
      severity: "critical",
      rule: "retry_rate",
      summary: `Retry rate ${(retryRate * 100).toFixed(1)}% over ${snapshot.window_seconds}s exceeds critical threshold ${(thresholds.retry_rate_critical * 100).toFixed(0)}%`,
      source,
      details: { retryRate, ...snapshot },
      occurred_at: now,
    });
  } else if (retryRate >= thresholds.retry_rate_warn) {
    out.push({
      severity: "warn",
      rule: "retry_rate",
      summary: `Retry rate ${(retryRate * 100).toFixed(1)}% over ${snapshot.window_seconds}s exceeds warning threshold ${(thresholds.retry_rate_warn * 100).toFixed(0)}%`,
      source,
      details: { retryRate, ...snapshot },
      occurred_at: now,
    });
  }

  if (snapshot.dead >= thresholds.dead_letter_count_critical) {
    out.push({
      severity: "critical",
      rule: "dead_letter_count",
      summary: `${snapshot.dead} dead letters in ${snapshot.window_seconds}s exceeds critical threshold ${thresholds.dead_letter_count_critical}`,
      source,
      details: { ...snapshot },
      occurred_at: now,
    });
  } else if (snapshot.dead >= thresholds.dead_letter_count_warn) {
    out.push({
      severity: "warn",
      rule: "dead_letter_count",
      summary: `${snapshot.dead} dead letters in ${snapshot.window_seconds}s exceeds warning threshold ${thresholds.dead_letter_count_warn}`,
      source,
      details: { ...snapshot },
      occurred_at: now,
    });
  }

  return out;
}

export interface QueueLagSnapshot {
  /** Age of the oldest un-acked queue message, or null when the provider cannot report it. */
  oldest_unacked_age_seconds: number | null;
  /** Total messages waiting across all shards. */
  backlog: number;
}

export function evaluateQueueLag(
  snapshot: QueueLagSnapshot,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
  source = "router",
): AlertEvent[] {
  const out: AlertEvent[] = [];
  if (snapshot.oldest_unacked_age_seconds === null) return out;
  const now = new Date().toISOString();

  if (snapshot.oldest_unacked_age_seconds >= thresholds.queue_lag_seconds_critical) {
    out.push({
      severity: "critical",
      rule: "queue_lag",
      summary: `Oldest unacked message is ${snapshot.oldest_unacked_age_seconds}s old (backlog ${snapshot.backlog})`,
      source,
      details: { ...snapshot, threshold: thresholds.queue_lag_seconds_critical },
      occurred_at: now,
    });
  } else if (snapshot.oldest_unacked_age_seconds >= thresholds.queue_lag_seconds_warn) {
    out.push({
      severity: "warn",
      rule: "queue_lag",
      summary: `Oldest unacked message is ${snapshot.oldest_unacked_age_seconds}s old (backlog ${snapshot.backlog})`,
      source,
      details: { ...snapshot, threshold: thresholds.queue_lag_seconds_warn },
      occurred_at: now,
    });
  }
  return out;
}

export interface EngineErrorSnapshot {
  evaluations: number;
  errors: number;
  window_seconds: number;
}

export function evaluateEngineErrors(
  snapshot: EngineErrorSnapshot,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
  source = "router",
): AlertEvent[] {
  const out: AlertEvent[] = [];
  const now = new Date().toISOString();
  if (snapshot.evaluations === 0) return out;
  const rate = snapshot.errors / snapshot.evaluations;
  if (rate >= thresholds.engine_error_rate_critical) {
    out.push({
      severity: "critical",
      rule: "engine_error_rate",
      summary: `Declarative engine error rate ${(rate * 100).toFixed(1)}% in ${snapshot.window_seconds}s exceeds critical ${(thresholds.engine_error_rate_critical * 100).toFixed(0)}%`,
      source,
      details: { rate, ...snapshot },
      occurred_at: now,
    });
  } else if (rate >= thresholds.engine_error_rate_warn) {
    out.push({
      severity: "warn",
      rule: "engine_error_rate",
      summary: `Declarative engine error rate ${(rate * 100).toFixed(1)}% in ${snapshot.window_seconds}s exceeds warning ${(thresholds.engine_error_rate_warn * 100).toFixed(0)}%`,
      source,
      details: { rate, ...snapshot },
      occurred_at: now,
    });
  }
  return out;
}

export interface DestinationLatencySnapshot {
  destination_id: string;
  route_id?: string;
  p95_latency_ms: number;
  attempts: number;
  window_seconds: number;
}

export function evaluateDestinationLatency(
  snapshot: DestinationLatencySnapshot,
  thresholds: AlertThresholds = DEFAULT_THRESHOLDS,
  source = "delivery",
): AlertEvent[] {
  const now = new Date().toISOString();
  if (snapshot.attempts === 0) return [];
  const operationalDetails = {
    p95_latency_ms: snapshot.p95_latency_ms,
    attempts: snapshot.attempts,
    window_seconds: snapshot.window_seconds,
  };
  if (snapshot.p95_latency_ms >= thresholds.destination_p95_latency_ms_critical) {
    return [{
      severity: "critical",
      rule: "destination_p95_latency",
      summary: `Destination p95 latency ${snapshot.p95_latency_ms}ms exceeds critical threshold ${thresholds.destination_p95_latency_ms_critical}ms`,
      source,
      details: { ...operationalDetails, threshold: thresholds.destination_p95_latency_ms_critical },
      occurred_at: now,
    }];
  }
  if (snapshot.p95_latency_ms >= thresholds.destination_p95_latency_ms_warn) {
    return [{
      severity: "warn",
      rule: "destination_p95_latency",
      summary: `Destination p95 latency ${snapshot.p95_latency_ms}ms exceeds warning threshold ${thresholds.destination_p95_latency_ms_warn}ms`,
      source,
      details: { ...operationalDetails, threshold: thresholds.destination_p95_latency_ms_warn },
      occurred_at: now,
    }];
  }
  return [];
}

/**
 * Reads ALERT_WEBHOOK_URL / ALERT_WEBHOOK_TOKEN from the environment.
 * Returns the silent sink if no URL is set so the absence of config never
 * crashes the service.
 */
export function alertSinkFromEnv(env: Record<string, string | undefined> = process.env): AlertSink {
  const url = env.ALERT_WEBHOOK_URL;
  if (!url) return silentAlertSink();
  return webhookAlertSink({
    url,
    ...(env.ALERT_WEBHOOK_TOKEN ? { token: env.ALERT_WEBHOOK_TOKEN } : {}),
  });
}
