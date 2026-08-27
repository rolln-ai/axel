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
  observe(queueId: string): Promise<void>;
  onError(error: unknown, queueId: string): void | Promise<void>;
}

export interface QueueRealtimeMetricsRunner {
  /** Start a detached observation. Returns false while this queue is already observed. */
  start(queueId: string): boolean;
  isInFlight(queueId: string): boolean;
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
    throw new Error("cloudflare_queue_metrics_oldest_timestamp_missing");
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

  return {
    start(queueId) {
      if (inFlight.has(queueId)) return false;
      inFlight.add(queueId);
      void Promise.resolve()
        .then(() => options.observe(queueId))
        .catch((error) => options.onError(error, queueId))
        .catch(() => undefined)
        .finally(() => inFlight.delete(queueId));
      return true;
    },
    isInFlight(queueId) {
      return inFlight.has(queueId);
    },
  };
}
