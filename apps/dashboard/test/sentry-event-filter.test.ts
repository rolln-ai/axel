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
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(event.exception.values[0]?.value).toBe("dashboard_error");
  });

  it("keeps ordinary SDK events", () => {
    const event = { event_id: "event-1" };

    expect(
      filterDashboardSentryEvent(event, {
        originalException: new Error("checkout failed"),
      }),
    ).toBe(event);
  });

  it("keeps the SDK event id while removing user and business identifiers", () => {
    const event = {
      event_id: "sentry-event-id",
      user: {
        id: "user-private",
        email: "private@example.test",
      },
      tags: {
        component: "billing_checkout",
        workspace_id: "workspace-private",
        destinationId: "destination-private",
      },
      extra: {
        event_id: "event-private",
        nested: { source_id: "source-private", routeId: "route-private" },
      },
      breadcrumbs: [{ data: { customer_id: "customer-private" } }],
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
    expect(event.event_id).toBe("sentry-event-id");
    expect(event).not.toHaveProperty("user");
    expect(event.tags).toEqual({ component: "billing_checkout" });
    expect(event).not.toHaveProperty("extra");
    expect(event).not.toHaveProperty("breadcrumbs");
    expect(JSON.stringify(event)).not.toContain("private");
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
    expect(serialized).toContain("dashboard_error");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("db-password");
    expect(serialized).not.toContain("private-key");
  });

  it("drops arbitrary exception types, frame text, extras, and tag values", () => {
    const event = {
      event_id: "sentry-event-id",
      tags: {
        component: "delivery_panel",
        workspace_id: "workspace-canary",
      },
      extra: { innocuous: "webhook-canary" },
      exception: {
        values: [
          {
            type: "WebhookCanaryError",
            value: "webhook-canary",
            stacktrace: {
              frames: [
                {
                  filename: "https://private-host.invalid/webhook-canary.js?token=secret",
                  function: "webhookCanary",
                  lineno: 42,
                  colno: 7,
                },
              ],
            },
          },
        ],
      },
    };

    expect(filterDashboardSentryEvent(event)).toBe(event);
    expect(event.tags).toEqual({ component: "delivery_panel" });
    expect(event).not.toHaveProperty("extra");
    expect(event.exception.values[0]).toEqual({
      type: "Error",
      value: "dashboard_error",
      mechanism: undefined,
      stacktrace: {
        frames: [
          {
            filename: "[external]",
            function: "<anonymous>",
            lineno: 42,
            colno: 7,
          },
        ],
      },
    });
    expect(JSON.stringify(event)).not.toContain("canary");
    expect(JSON.stringify(event)).not.toContain("private-host");
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
    expect(warn).toHaveBeenCalledWith("[sentry] dropping transient pg SDK event");
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
