import { beforeEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => {
  const scope = {
    setLevel: vi.fn(),
    setTags: vi.fn(),
    setExtras: vi.fn(),
    setUser: vi.fn(),
  };

  return {
    scope,
    captureException: vi.fn(() => "0123456789abcdef0123456789abcdef"),
    flush: vi.fn(async () => true),
    isEnabled: vi.fn(() => true),
    withScope: vi.fn((callback: (value: unknown) => unknown) => callback(scope)),
  };
});

vi.mock("@sentry/nextjs", () => ({
  captureException: sentryMocks.captureException,
  flush: sentryMocks.flush,
  isEnabled: sentryMocks.isEnabled,
  withScope: sentryMocks.withScope,
}));

import {
  captureDashboardException,
  captureDashboardExceptionAndFlush,
} from "../lib/sentry-capture";

beforeEach(() => {
  vi.clearAllMocks();
  sentryMocks.captureException.mockReturnValue("0123456789abcdef0123456789abcdef");
  sentryMocks.flush.mockResolvedValue(true);
  sentryMocks.isEnabled.mockReturnValue(true);
});

describe("captureDashboardException", () => {
  it("captures through the official SDK with sanitized, identity-free context", async () => {
    const error = new Error("checkout failed");
    const tags = {
      component: "billing_checkout",
      workspace_id: "ws_123",
      retryable: false,
    };
    const extra = {
      stripe_request_id: "req_customer_private",
      destination_url: "https://customer.example/hook?token=private",
      provider_error: "transport rejected customer@example.com at private.internal",
      nested: {
        customer_id: "cus_private",
        destination_id: "dst_private",
        event_id: "evt_private",
        authorization: "Bearer private",
      },
    };
    const user = { id: "user_123", email: "owner@example.com" };

    await captureDashboardException(error, {
      level: "warning",
      tags,
      extra,
      user,
    });

    expect(sentryMocks.withScope).toHaveBeenCalledOnce();
    expect(sentryMocks.scope.setLevel).toHaveBeenCalledWith("warning");
    expect(sentryMocks.scope.setTags).toHaveBeenCalledWith({
      component: "billing_checkout",
      workspace_id: "[REDACTED]",
      retryable: false,
    });
    expect(sentryMocks.scope.setExtras).toHaveBeenCalledWith({
      stripe_request_id: "operation_failed",
      destination_url: "operation_failed",
      provider_error: "operation_failed",
      nested: {
        customer_id: "[REDACTED]",
        destination_id: "[REDACTED]",
        event_id: "[REDACTED]",
        authorization: "[REDACTED]",
      },
    });
    const serializedContext = JSON.stringify([
      sentryMocks.scope.setTags.mock.calls,
      sentryMocks.scope.setExtras.mock.calls,
    ]);
    expect(serializedContext).not.toContain("req_customer_private");
    expect(serializedContext).not.toContain("customer.example");
    expect(serializedContext).not.toContain("customer@example.com");
    expect(serializedContext).not.toContain("private.internal");
    expect(serializedContext).not.toContain("cus_private");
    expect(serializedContext).not.toContain("dst_private");
    expect(serializedContext).not.toContain("evt_private");
    expect(serializedContext).not.toContain("owner@example.com");
    expect(sentryMocks.scope.setUser).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
    expect(sentryMocks.flush).toHaveBeenCalledWith(2_000);
  });

  it("swallows SDK flush failures so reporting cannot break the caller", async () => {
    sentryMocks.flush.mockRejectedValueOnce(
      new Error("transport unavailable for ws_private"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(captureDashboardException(new Error("handled failure"))).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith("[sentry] dashboard capture failed");
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("ws_private");
  });

  it("quietly skips best-effort capture when the SDK is not configured", async () => {
    sentryMocks.isEnabled.mockReturnValueOnce(false);

    await expect(captureDashboardException(new Error("dev failure"))).resolves.toBeUndefined();

    expect(sentryMocks.captureException).not.toHaveBeenCalled();
    expect(sentryMocks.flush).not.toHaveBeenCalled();
  });

  it("returns an event ID only after the local SDK queue flushes", async () => {
    const error = new Error("source map probe");

    await expect(captureDashboardExceptionAndFlush(error)).resolves.toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(sentryMocks.captureException).toHaveBeenCalledWith(error);
    expect(sentryMocks.flush).toHaveBeenCalledWith(2_000);
  });

  it("rejects the strict local capture when the SDK reports a flush timeout", async () => {
    sentryMocks.flush.mockResolvedValueOnce(false);

    await expect(
      captureDashboardExceptionAndFlush(new Error("source map probe")),
    ).rejects.toThrow("did not flush");
  });
});
