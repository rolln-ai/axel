import type { QueueLagSnapshot } from "@axel/router";

export interface QueueRealtimeMetrics {
  backlogCount: number;
  backlogBytes: number;
  oldestMessageTimestampMs: number;
}

export interface FetchQueueRealtimeMetricsOptions {
  accountId: string;
  queueId: string;
  token: string;
  fetchImpl?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

export interface QueueRealtimeMetricsRunnerOptions {
  observe(queueId: string): Promise<QueueLagSnapshot>;
  onError(error: unknown, queueId: string): void | Promise<void>;
  now?: () => number;
  /** Samples older than this are unavailable, not a current healthy reading. */
  maxAgeMs?: number;
}

export interface QueueRealtimeMetricsRunner {
  /** Start a detached observation. Returns false while this queue is already observed. */
  start(queueId: string): boolean;
  isInFlight(queueId: string): boolean;
  renderPrometheus(): string[];
}

function nonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`cloudflare_queue_metrics_invalid_${field}`);
  }
  return value;
}

/** Convert provider metrics into a queue-lag sample without masking degraded telemetry. */
export function queueRealtimeMetricsToLagSnapshot(
  metrics: QueueRealtimeMetrics,
  nowMs: number,
): QueueLagSnapshot {
  if (metrics.oldestMessageTimestampMs > nowMs) {
    throw new Error("cloudflare_queue_metrics_oldest_timestamp_future");
  }
  if (metrics.backlogCount > 0 && metrics.oldestMessageTimestampMs === 0) {
    // Cloudflare documents zero as unknown, even when messages are waiting.
    return { oldest_unacked_age_seconds: null, backlog: metrics.backlogCount };
  }
  if (metrics.backlogCount === 0) {
    return { oldest_unacked_age_seconds: 0, backlog: 0 };
  }
  return {
    oldest_unacked_age_seconds: Math.round(
      (nowMs - metrics.oldestMessageTimestampMs) / 1_000,
    ),
    backlog: metrics.backlogCount,
  };
}

/** Read Cloudflare's best-effort realtime Queue metrics without leasing data. */
export async function fetchQueueRealtimeMetrics(
  options: FetchQueueRealtimeMetricsOptions,
): Promise<QueueRealtimeMetrics> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.apiBase ?? "https://api.cloudflare.com/client/v4";
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error("cloudflare_queue_metrics_deadline_exceeded"));
    }, options.timeoutMs ?? 15_000);
  });

  try {
    let response: Response;
    try {
      response = await Promise.race([
        fetchImpl(
          `${apiBase}/accounts/${options.accountId}/queues/${options.queueId}/metrics`,
          {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
            headers: {
              accept: "application/json",
              authorization: `Bearer ${options.token}`,
            },
          },
        ),
        deadline,
      ]);
    } catch {
      throw new Error("cloudflare_queue_metrics_request_failed");
    }
    if (!response.ok) throw new Error(`cloudflare_queue_metrics_http_${response.status}`);

    let body: unknown;
    try {
      body = await Promise.race([response.json(), deadline]);
    } catch {
      throw new Error("cloudflare_queue_metrics_response_invalid");
    }
    if (!body || typeof body !== "object" || (body as { success?: unknown }).success !== true) {
      throw new Error("cloudflare_queue_metrics_response_unsuccessful");
    }
    const result = (body as { result?: unknown }).result;
    if (!result || typeof result !== "object") {
      throw new Error("cloudflare_queue_metrics_result_invalid");
    }
    const values = result as Record<string, unknown>;
    return {
      backlogCount: nonNegativeNumber(values.backlog_count, "backlog_count"),
      backlogBytes: nonNegativeNumber(values.backlog_bytes, "backlog_bytes"),
      oldestMessageTimestampMs: nonNegativeNumber(
        values.oldest_message_timestamp_ms,
        "oldest_message_timestamp_ms",
      ),
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Run Queue metrics beside the delivery loop without allowing overlapping
 * requests for the same queue. Errors are consumed after being handed to the
 * best-effort observer, so this runner can never reject into delivery work.
 */
export function createQueueRealtimeMetricsRunner(
  options: QueueRealtimeMetricsRunnerOptions,
): QueueRealtimeMetricsRunner {
  const inFlight = new Set<string>();
  const observations = new Map<string, { snapshot: QueueLagSnapshot | null; observedAt: number }>();
  const now = options.now ?? Date.now;

  return {
    start(queueId) {
      if (inFlight.has(queueId)) return false;
      inFlight.add(queueId);
      if (!observations.has(queueId)) observations.set(queueId, { snapshot: null, observedAt: 0 });
      void Promise.resolve()
        .then(() => options.observe(queueId))
        .then((snapshot) => observations.set(queueId, { snapshot, observedAt: now() }))
        .catch((error) => {
          observations.set(queueId, { snapshot: null, observedAt: observations.get(queueId)?.observedAt ?? 0 });
          return options.onError(error, queueId);
        })
        .catch(() => undefined)
        .finally(() => inFlight.delete(queueId));
      return true;
    },
    isInFlight(queueId) {
      return inFlight.has(queueId);
    },
    renderPrometheus() {
      const lines = [
        "# HELP axel_delivery_queue_metrics_available Whether this queue has a recent successful provider sample.",
        "# TYPE axel_delivery_queue_metrics_available gauge",
        "# HELP axel_delivery_queue_oldest_age_available Whether the recent sample includes the oldest message age.",
        "# TYPE axel_delivery_queue_oldest_age_available gauge",
        "# HELP axel_delivery_queue_backlog Unacknowledged messages in the recent provider sample.",
        "# TYPE axel_delivery_queue_backlog gauge",
        "# HELP axel_delivery_queue_oldest_unacked_age_seconds Oldest message age at the last observation, omitted when unknown.",
        "# TYPE axel_delivery_queue_oldest_unacked_age_seconds gauge",
        "# HELP axel_delivery_queue_metrics_observed_timestamp_seconds Unix timestamp of the last successful provider sample.",
        "# TYPE axel_delivery_queue_metrics_observed_timestamp_seconds gauge",
      ];
      const nowMs = now();
      for (const [queueId, observation] of observations) {
        const label = JSON.stringify(queueId);
        const elapsed = nowMs - observation.observedAt;
        const snapshot = elapsed >= 0 && elapsed <= (options.maxAgeMs ?? 120_000) ? observation.snapshot : null;
        const ageKnown = snapshot !== null && snapshot.oldest_unacked_age_seconds !== null;
        lines.push(
          `axel_delivery_queue_metrics_available{queue=${label}} ${snapshot !== null ? 1 : 0}`,
          `axel_delivery_queue_oldest_age_available{queue=${label}} ${ageKnown ? 1 : 0}`,
          `axel_delivery_queue_metrics_observed_timestamp_seconds{queue=${label}} ${observation.observedAt / 1000}`,
        );
        if (snapshot !== null) lines.push(`axel_delivery_queue_backlog{queue=${label}} ${snapshot.backlog}`);
        if (ageKnown) lines.push(`axel_delivery_queue_oldest_unacked_age_seconds{queue=${label}} ${snapshot.oldest_unacked_age_seconds}`);
      }
      return lines;
    },
  };
}
