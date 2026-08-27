import { describe, expect, it, vi } from "vitest";
import {
  createQueueRealtimeMetricsRunner,
  fetchQueueRealtimeMetrics,
  queueRealtimeMetricsToLagSnapshot,
} from "../src/queue-realtime-metrics.js";

const OPTIONS = {
  accountId: "a".repeat(32),
  queueId: "b".repeat(32),
  token: "queue-secret-never-log",
  apiBase: "https://cloudflare.example.test/client/v4",
};

describe("Cloudflare realtime Queue metrics", () => {
  it("reads validated backlog metrics without leasing a message", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      result: {
        backlog_count: 12,
        backlog_bytes: 4096,
        oldest_message_timestamp_ms: 1_700_000_000_000,
      },
    })));

    await expect(fetchQueueRealtimeMetrics({ ...OPTIONS, fetchImpl })).resolves.toEqual({
      backlogCount: 12,
      backlogBytes: 4096,
      oldestMessageTimestampMs: 1_700_000_000_000,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      `${OPTIONS.apiBase}/accounts/${OPTIONS.accountId}/queues/${OPTIONS.queueId}/metrics`,
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("fails closed on invalid metrics", async () => {
    await expect(fetchQueueRealtimeMetrics({
      ...OPTIONS,
      fetchImpl: async () => new Response(JSON.stringify({
        success: true,
        result: { backlog_count: -1, backlog_bytes: 0, oldest_message_timestamp_ms: 0 },
      })),
    })).rejects.toThrow(/cloudflare_queue_metrics_invalid_backlog_count/);
  });

  it("does not read or expose provider error bodies", async () => {
    let bodyRead = false;
    const response = new Response("provider-secret-never-log", { status: 503 });
    Object.defineProperty(response, "json", {
      value: async () => {
        bodyRead = true;
        return {};
      },
    });
    await expect(fetchQueueRealtimeMetrics({
      ...OPTIONS,
      fetchImpl: async () => response,
    })).rejects.toThrow("cloudflare_queue_metrics_http_503");
    expect(bodyRead).toBe(false);
  });

  it("bounds a fetch that never settles", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const result = fetchQueueRealtimeMetrics({
        ...OPTIONS,
        timeoutMs: 25,
        fetchImpl: async (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return await new Promise<Response>(() => undefined);
        },
      });
      const rejection = expect(result).rejects.toThrow(
        "cloudflare_queue_metrics_request_failed",
      );

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds response body consumption even when json ignores abort", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const response = {
        ok: true,
        status: 200,
        json: () => new Promise<never>(() => undefined),
      } as Response;
      const result = fetchQueueRealtimeMetrics({
        ...OPTIONS,
        timeoutMs: 25,
        fetchImpl: async (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return response;
        },
      });
      const rejection = expect(result).rejects.toThrow(
        "cloudflare_queue_metrics_response_invalid",
      );

      await vi.advanceTimersByTimeAsync(25);

      await rejection;
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Queue realtime metrics snapshot conversion", () => {
  const NOW = 1_700_000_000_000;

  it("converts a valid nonempty backlog", () => {
    expect(queueRealtimeMetricsToLagSnapshot({
      backlogCount: 12,
      backlogBytes: 4096,
      oldestMessageTimestampMs: NOW - 90_000,
    }, NOW)).toEqual({
      oldest_unacked_age_seconds: 90,
      backlog: 12,
    });
  });

  it("keeps an empty backlog healthy when the provider reports no oldest message", () => {
    expect(queueRealtimeMetricsToLagSnapshot({
      backlogCount: 0,
      backlogBytes: 0,
      oldestMessageTimestampMs: 0,
    }, NOW)).toEqual({
      oldest_unacked_age_seconds: 0,
      backlog: 0,
    });
  });

  it("reports degraded telemetry when a nonempty backlog has no oldest timestamp", () => {
    expect(() => queueRealtimeMetricsToLagSnapshot({
      backlogCount: 1,
      backlogBytes: 10,
      oldestMessageTimestampMs: 0,
    }, NOW)).toThrow("cloudflare_queue_metrics_oldest_timestamp_missing");
  });

  it("reports degraded telemetry instead of masking a future timestamp as healthy", () => {
    expect(() => queueRealtimeMetricsToLagSnapshot({
      backlogCount: 1,
      backlogBytes: 10,
      oldestMessageTimestampMs: NOW + 1,
    }, NOW)).toThrow("cloudflare_queue_metrics_oldest_timestamp_future");
  });
});

describe("Queue realtime metrics runner", () => {
  it("runs detached, suppresses same-queue overlap, and isolates queues", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const observe = vi.fn((queueId: string) => queueId === "queue-a" ? first : Promise.resolve());
    const onError = vi.fn();
    const runner = createQueueRealtimeMetricsRunner({ observe, onError });

    expect(runner.start("queue-a")).toBe(true);
    expect(runner.start("queue-a")).toBe(false);
    expect(runner.start("queue-b")).toBe(true);
    expect(runner.isInFlight("queue-a")).toBe(true);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledTimes(2));

    releaseFirst();
    await vi.waitFor(() => expect(runner.isInFlight("queue-a")).toBe(false));
    expect(runner.start("queue-a")).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it("consumes synchronous observation and error-reporter failures, then permits a retry", async () => {
    const observe = vi.fn(() => {
      throw new Error("provider unavailable");
    });
    const runner = createQueueRealtimeMetricsRunner({
      observe,
      onError: async () => {
        throw new Error("reporter unavailable");
      },
    });

    expect(runner.start("queue-a")).toBe(true);
    await vi.waitFor(() => expect(runner.isInFlight("queue-a")).toBe(false));
    expect(runner.start("queue-a")).toBe(true);
  });
});
