import { describe, expect, it, vi } from "vitest";
import {
  consoleAlertSink,
  DEFAULT_THRESHOLDS,
  evaluateDeliveryHealth,
  evaluateDestinationLatency,
  evaluateQueueLag,
  evaluateEngineErrors,
  multiAlertSink,
  silentAlertSink,
  webhookAlertSink,
} from "../src/index.ts";

describe("threshold evaluators", () => {
  it("returns no alerts when delivery snapshot is healthy", () => {
    const events = evaluateDeliveryHealth({
      attempts: 1000,
      successes: 990,
      retries: 8,
      dead: 2,
      window_seconds: 300,
    });
    expect(events).toEqual([]);
  });

  it("warns on retry rate above warn threshold", () => {
    const events = evaluateDeliveryHealth({
      attempts: 1000,
      successes: 880,
      retries: 120,
      dead: 0,
      window_seconds: 300,
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.rule).toBe("retry_rate");
    expect(events[0]?.severity).toBe("warn");
  });

  it("escalates retry rate to critical past critical threshold", () => {
    const events = evaluateDeliveryHealth({
      attempts: 1000,
      successes: 700,
      retries: 300,
      dead: 0,
      window_seconds: 300,
    });
    const retryAlert = events.find((e) => e.rule === "retry_rate");
    expect(retryAlert?.severity).toBe("critical");
  });

  it("emits dead-letter alert independently of retry alert", () => {
    const events = evaluateDeliveryHealth({
      attempts: 5000,
      successes: 4700,
      retries: 50,
      dead: 250,
      window_seconds: 300,
    });
    const ruleSeverities = events.map((e) => `${e.rule}:${e.severity}`);
    expect(ruleSeverities).toContain("dead_letter_count:critical");
  });

  it("returns no alerts when there are zero attempts", () => {
    const events = evaluateDeliveryHealth({
      attempts: 0,
      successes: 0,
      retries: 0,
      dead: 0,
      window_seconds: 300,
    });
    expect(events).toEqual([]);
  });

  it("queue lag evaluator escalates by age bucket", () => {
    expect(evaluateQueueLag({ oldest_unacked_age_seconds: null, backlog: 100 })).toEqual([]);
    expect(evaluateQueueLag({ oldest_unacked_age_seconds: 30, backlog: 100 })).toEqual([]);
    expect(evaluateQueueLag({ oldest_unacked_age_seconds: 90, backlog: 100 })[0]?.severity).toBe("warn");
    expect(evaluateQueueLag({ oldest_unacked_age_seconds: 600, backlog: 100 })[0]?.severity).toBe("critical");
  });

  it("declarative engine error rate evaluator respects thresholds", () => {
    const events = evaluateEngineErrors({ evaluations: 100, errors: 30, window_seconds: 60 });
    expect(events[0]?.rule).toBe("engine_error_rate");
    expect(events[0]?.severity).toBe("critical");
  });

  it("destination latency evaluator escalates by p95 latency", () => {
    expect(evaluateDestinationLatency({
      destination_id: "dst_1",
      p95_latency_ms: 500,
      attempts: 100,
      window_seconds: 300,
    })).toEqual([]);
    const warning = evaluateDestinationLatency({
      destination_id: "dst_1",
      route_id: "rte_private_marker",
      p95_latency_ms: 2500,
      attempts: 100,
      window_seconds: 300,
    })[0];
    expect(warning?.severity).toBe("warn");
    expect(JSON.stringify(warning)).not.toContain("dst_1");
    expect(JSON.stringify(warning)).not.toContain("rte_private_marker");
    expect(evaluateDestinationLatency({
      destination_id: "dst_1",
      p95_latency_ms: 6000,
      attempts: 100,
      window_seconds: 300,
    })[0]?.severity).toBe("critical");
  });

  it("custom thresholds override defaults", () => {
    const events = evaluateDeliveryHealth(
      { attempts: 1000, successes: 999, retries: 1, dead: 0, window_seconds: 60 },
      { ...DEFAULT_THRESHOLDS, retry_rate_warn: 0.0001, retry_rate_critical: 0.0002 },
    );
    const alert = events.find((e) => e.rule === "retry_rate");
    expect(alert?.severity).toBe("critical");
  });
});

describe("alert sinks", () => {
  it("silent sink swallows everything", async () => {
    const sink = silentAlertSink();
    await expect(sink.notify({
      severity: "warn",
      rule: "test",
      summary: "x",
      source: "router",
      details: {},
      occurred_at: new Date().toISOString(),
    })).resolves.toBeUndefined();
  });

  it("console sink writes to stderr", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await consoleAlertSink().notify({
      severity: "critical",
      rule: "queue_lag",
      summary: "lag",
      source: "router",
      details: { age: 600 },
      occurred_at: new Date().toISOString(),
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toContain("queue_lag");
    spy.mockRestore();
  });

  it("multi sink fans out and survives failures in any leg", async () => {
    let aHits = 0;
    const a = { async notify() { aHits += 1; } };
    const b = { async notify() { throw new Error("boom"); } };
    let cHits = 0;
    const c = { async notify() { cHits += 1; } };

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await multiAlertSink([a, b, c]).notify({
      severity: "info",
      rule: "x",
      summary: "y",
      source: "router",
      details: {},
      occurred_at: new Date().toISOString(),
    });

    expect(aHits).toBe(1);
    expect(cHits).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("webhook sink POSTs JSON with the expected envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch: typeof fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await webhookAlertSink({ url: "https://example.com/hook", token: "tk", fetchImpl: fakeFetch }).notify({
      severity: "warn",
      rule: "retry_rate",
      summary: "customer-summary-marker",
      source: "router",
      details: {
        rate: 0.18,
        destination_id: "destination-marker",
        nested: { count: 2, provider_response: "provider-marker" },
      },
      occurred_at: "2026-05-15T10:00:00Z",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.com/hook");
    expect(calls[0]?.init.redirect).toBe("manual");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.["x-axel-alert-token"]).toBe("tk");
    const body = JSON.parse(calls[0]?.init.body as string) as {
      text: string;
      event: { rule: string; summary: string; details: Record<string, unknown> };
    };
    expect(body.text).toMatch(/WARN/);
    expect(body.event.rule).toBe("retry_rate");
    expect(body.event.summary).toBe("Operational alert emitted.");
    expect(body.event.details).toEqual({ rate: 0.18, nested: { count: 2 } });
    expect(JSON.stringify(body)).not.toContain("customer-summary-marker");
    expect(JSON.stringify(body)).not.toContain("destination-marker");
    expect(JSON.stringify(body)).not.toContain("provider-marker");
  });

  it("webhook sink swallows fetch failures (alerting must not page itself)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    await expect(webhookAlertSink({ url: "https://x", fetchImpl: fakeFetch }).notify({
      severity: "info",
      rule: "x",
      summary: "y",
      source: "router",
      details: {},
      occurred_at: new Date().toISOString(),
    })).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("webhook sink reports non-success responses without reading receiver bodies", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let bodyRead = false;
    const response = new Response("receiver-secret-never-log", { status: 503 });
    Object.defineProperty(response, "text", {
      value: async () => {
        bodyRead = true;
        return "receiver-secret-never-log";
      },
    });
    const fakeFetch: typeof fetch = (async () => response) as typeof fetch;

    await expect(webhookAlertSink({ url: "https://x", fetchImpl: fakeFetch }).notify({
      severity: "critical",
      rule: "queue_lag",
      summary: "lagged",
      source: "delivery",
      details: { backlog: 12 },
      occurred_at: new Date().toISOString(),
    })).resolves.toBeUndefined();

    expect(bodyRead).toBe(false);
    expect(errSpy).toHaveBeenCalledWith("[alert webhook] post failed");
    expect(JSON.stringify(errSpy.mock.calls)).not.toContain("receiver-secret-never-log");
    errSpy.mockRestore();
  });
});
