import type { SentryClient } from "@axel/observability";
import { describe, expect, it, vi } from "vitest";
import { createSentryAlertSink } from "../src/sentry-alert-sink.js";

describe("Sentry operational alert sink", () => {
  it("captures a stable issue with only generated operational metadata", async () => {
    const captureException = vi.fn(async () => undefined);
    const client = { captureException } as unknown as SentryClient;

    await createSentryAlertSink(client).notify({
      severity: "critical",
      rule: "queue_lag",
      summary: "customer-summary-marker",
      source: "delivery",
      details: {
        oldest_unacked_age_seconds: 600,
        backlog: 12,
        threshold: 300,
        destination_id: "destination-marker",
        provider_response: "provider-marker",
      },
      occurred_at: "2026-08-27T18:30:00.000Z",
    });

    expect(captureException).toHaveBeenCalledOnce();
    const [error, context] = captureException.mock.calls[0] ?? [];
    expect(error).toMatchObject({ message: "operational_alert:delivery:queue_lag:critical" });
    expect(context).toEqual({
      level: "error",
      fingerprint: ["operational_alert", "delivery", "queue_lag", "critical"],
      tags: {
        component: "operational_alert",
        alert_rule: "queue_lag",
        alert_source: "delivery",
        alert_severity: "critical",
      },
      extra: {
        summary: "Operational alert emitted.",
        details: {
          oldest_unacked_age_seconds: 600,
          backlog: 12,
          threshold: 300,
        },
        occurred_at: "2026-08-27T18:30:00.000Z",
      },
    });
    expect(JSON.stringify(captureException.mock.calls)).not.toContain("customer-summary-marker");
    expect(JSON.stringify(captureException.mock.calls)).not.toContain("destination-marker");
    expect(JSON.stringify(captureException.mock.calls)).not.toContain("provider-marker");
  });

  it("uses a different Issue fingerprint for warning and critical events", async () => {
    const captureException = vi.fn(async () => undefined);
    const client = { captureException } as unknown as SentryClient;
    const sink = createSentryAlertSink(client);

    for (const severity of ["warn", "critical"] as const) {
      await sink.notify({
        severity,
        rule: "queue_lag",
        summary: "Controlled test",
        source: "delivery",
        details: {},
        occurred_at: "2026-08-27T18:30:00.000Z",
      });
    }

    expect(captureException.mock.calls.map(([, context]) => context?.fingerprint)).toEqual([
      ["operational_alert", "delivery", "queue_lag", "warn"],
      ["operational_alert", "delivery", "queue_lag", "critical"],
    ]);
  });

  it("is a no-op when Sentry is not configured", async () => {
    await expect(createSentryAlertSink(null).notify({
      severity: "warn",
      rule: "queue_lag",
      summary: "lagged",
      source: "delivery",
      details: {},
      occurred_at: "2026-08-27T18:30:00.000Z",
    })).resolves.toBeUndefined();
  });
});
