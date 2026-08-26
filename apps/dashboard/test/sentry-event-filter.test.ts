import { afterEach, describe, expect, it, vi } from "vitest";
import { filterDashboardSentryEvent } from "../lib/sentry-event-filter";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dashboard Sentry event filter", () => {
  it("removes auth URL credentials from the entire outbound event", () => {
    const secrets = {
      reset: "reset-secret",
      verify: "verify-secret",
      invite: "invite-secret",
      apiKey: "api-key-secret",
      clientSecret: "client-secret-value",
      encoded: "encoded-secret",
    };
    const event = {
      event_id: "event-credential-scrub",
      request: {
        url: `https://app.axel.invalid/reset?token=${secrets.reset}`,
        query_string: `token=${secrets.reset}&api_key=${secrets.apiKey}`,
        headers: {
          authorization: "Bearer browser-credential",
          referer: `https://app.axel.invalid/verify?token=${secrets.verify}`,
        },
      },
      breadcrumbs: [
        {
          category: "navigation",
          data: {
            from: `/verify?token=${secrets.verify}`,
            to: `/signup?invite=${secrets.invite}`,
          },
        },
        {
          category: "console",
          message: `GET https://app.axel.invalid/reset?token=${secrets.reset}`,
        },
        {
          category: "fetch",
          data: {
            url: `https%3A%2F%2Fapp.axel.invalid%2Fverify%3Ftoken%3D${secrets.encoded}`,
            client_secret: secrets.clientSecret,
          },
        },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: `Request failed at https://app.axel.invalid/signup?invite=${secrets.invite}`,
            mechanism: { handled: true },
          },
        ],
      },
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
    const serialized = JSON.stringify(event);
    for (const secret of [...Object.values(secrets), "browser-credential"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(event.request.url).toBe("https://app.axel.invalid/reset");
    expect(event.request.headers.authorization).toBe("[REDACTED]");
  });

  it("keeps ordinary SDK events", () => {
    const event = { event_id: "event-1" };

    expect(
      filterDashboardSentryEvent(event, {
        originalException: new Error("checkout failed"),
      }),
    ).toBe(event);
  });

  it("removes receiver-controlled HTTP details and plaintext URL credentials", () => {
    const event = {
      exception: {
        values: [
          {
            type: "Error",
            value:
              "HTTP 400: hunter2 from postgres://alice:db-password@db.example.test/main?sslkey=private-key",
          },
        ],
      },
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
    const serialized = JSON.stringify(event);
    expect(serialized).toContain("HTTP 400: [REDACTED]");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("db-password");
    expect(serialized).not.toContain("private-key");
  });

  it("drops TikTok WebView performance injection errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      filterDashboardSentryEvent({
        event_id: "event-tiktok-perf",
        contexts: {
          browser: {
            browser: "TikTok",
            name: "TikTok",
          },
        },
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined (reading 'domInteractive')",
              mechanism: { handled: false },
              stacktrace: {
                frames: [
                  {
                    filename: "<anonymous>",
                    function: "e.checkPerfReady",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[sentry] dropping Android WebView performance injection error",
    );
  });

  it("drops TikTok Lite performance injections reported as a generic WebView", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      filterDashboardSentryEvent({
        event_id: "event-tiktok-lite-perf",
        contexts: {
          browser: {
            browser: "Chrome Mobile WebView 138.0.7204",
            name: "Chrome Mobile WebView",
          },
        },
        exception: {
          values: [
            {
              type: "TypeError",
              value: "Cannot read properties of undefined (reading 'domInteractive')",
              mechanism: { handled: false },
              stacktrace: {
                frames: [
                  {
                    filename: "<anonymous>",
                    function: "e.checkPerfReady",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[sentry] dropping Android WebView performance injection error",
    );
  });

  it("drops Facebook Android navigation bridge teardown errors", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      filterDashboardSentryEvent({
        event_id: "event-facebook-navigation-perf",
        contexts: {
          browser: {
            browser: "Facebook 572.0.0",
            name: "Facebook",
          },
        },
        exception: {
          values: [
            {
              type: "Error",
              value: "Error invoking postMessage: Java object is gone",
              mechanism: { handled: false },
              stacktrace: {
                frames: [
                  {
                    filename: "app://navigation_performance_logger_android",
                    function: "sendJsBlockingTimeMessage",
                  },
                  {
                    filename: "app://navigation_performance_logger_android",
                    function: "sendDataToNative",
                  },
                ],
              },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[sentry] dropping Facebook navigation performance injection error",
    );
  });

  it("keeps similarly worded Facebook errors from application code", () => {
    const event = {
      event_id: "event-facebook-app",
      contexts: {
        browser: {
          name: "Facebook",
        },
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "Error invoking postMessage: Java object is gone",
            mechanism: { handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "app:///_next/static/chunks/dashboard.js",
                  function: "sendDataToNative",
                },
              ],
            },
          },
        ],
      },
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
  });

  it("keeps matching performance errors from application code", () => {
    const event = {
      event_id: "event-app-perf",
      contexts: {
        browser: {
          name: "Chrome",
        },
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: "Cannot read properties of undefined (reading 'domInteractive')",
            mechanism: { handled: false },
            stacktrace: {
              frames: [
                {
                  filename: "app:///_next/static/chunks/dashboard.js",
                  function: "checkPerfReady",
                },
              ],
            },
          },
        ],
      },
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
  });

  it("drops transient Postgres disconnects preserved from the custom handlers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      filterDashboardSentryEvent(
        {
          event_id: "event-2",
          exception: { values: [{ mechanism: { handled: false } }] },
        },
        { originalException: new Error("Connection terminated unexpectedly") },
      ),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[sentry] dropping transient pg SDK event:",
      "Connection terminated unexpectedly",
    );
  });

  it("keeps explicitly captured transient Postgres errors", () => {
    const event = {
      event_id: "event-3",
      exception: { values: [{ mechanism: { handled: true } }] },
    };

    expect(
      filterDashboardSentryEvent(event, {
        originalException: new Error("Connection terminated unexpectedly"),
      }),
    ).toBe(event);
  });

  it("drops handled stale Server Action events after a deployment", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(
      filterDashboardSentryEvent({
        event_id: "event-action-skew",
        exception: {
          values: [
            {
              type: "UnrecognizedActionError",
              value: 'Server Action "old-build-action" was not found on the server.',
              mechanism: { handled: true },
            },
          ],
        },
      }),
    ).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "[sentry] dropping handled stale Server Action event",
    );
  });

  it("keeps unhandled Server Action failures actionable", () => {
    const event = {
      event_id: "event-unhandled-action",
      exception: {
        values: [
          {
            type: "UnrecognizedActionError",
            value: 'Server Action "unknown" was not found on the server.',
            mechanism: { handled: false },
          },
        ],
      },
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
  });

  it("keeps an event when the SDK provides no original exception", () => {
    const event = { event_id: "event-4" };

    expect(filterDashboardSentryEvent(event)).toBe(event);
  });
});
