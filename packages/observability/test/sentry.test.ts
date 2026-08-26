import { describe, expect, it, vi } from "vitest";
import { captureException, createSentryClient, installNodeSentryHandlers, isCircuitBreakerOpenError, isCloudflareQueueInternalError, isCloudflareQueueOverloadError, isPoolAcquireTimeout, isTransientFetchError, isTransientPlatformHttpError, isTransientPostgresError, isTransientR2Error, sentryClientFromEnv, withPgRetry } from "../src/index.ts";

describe("sentry client", () => {
  it("sends Sentry envelopes to the DSN project endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (url, init) => {
      calls.push({ url: String(url), init: init as RequestInit });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = createSentryClient({
      dsn: "https://public@example.sentry.io/12345",
      service: "test-service",
      environment: "test",
      release: "abc123",
      fetchImpl,
      now: () => new Date("2026-05-14T12:00:00.000Z"),
    });

    await client.captureException(new Error("boom"), { tags: { route: "unit" }, extra: { ok: true } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.sentry.io/api/12345/envelope/");
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/x-sentry-envelope");
    expect(calls[0]?.init.body).toContain("\"service\":\"test-service\"");
    expect(calls[0]?.init.body).toContain("\"value\":\"boom\"");
  });

  it("redacts webhook values and secret-bearing context before sending", async () => {
    const calls: RequestInit[] = [];
    const client = createSentryClient({
      dsn: "https://public@example.sentry.io/12345",
      service: "delivery-service",
      fetchImpl: (async (_url, init) => {
        calls.push(init as RequestInit);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    await client.captureException(
      new Error(
        'destination echoed "alice@example.test" with Bearer top-secret and https://receiver.test/x?token=value',
      ),
      {
        extra: {
          payload: { password: "webhook-secret" },
          detail: "card 4111111111111111",
        },
      },
    );

    const envelope = String(calls[0]?.body);
    expect(envelope).not.toContain("alice@example.test");
    expect(envelope).not.toContain("top-secret");
    expect(envelope).not.toContain("token=value");
    expect(envelope).not.toContain("4111111111111111");
    expect(envelope).not.toContain("webhook-secret");
    expect(envelope).toContain("[REDACTED]");
  });

  it("drops unlabeled receiver response tails and URL credentials", async () => {
    const calls: RequestInit[] = [];
    const client = createSentryClient({
      dsn: "https://public@example.sentry.io/12345",
      service: "delivery-service",
      fetchImpl: (async (_url, init) => {
        calls.push(init as RequestInit);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    await client.captureException(
      new Error(
        "HTTP 400: hunter2 from postgres://alice:db-password@db.example.test/main?sslkey=private-key",
      ),
    );

    const envelope = String(calls[0]?.body);
    expect(envelope).toContain("HTTP 400: [REDACTED]");
    expect(envelope).not.toContain("hunter2");
    expect(envelope).not.toContain("db-password");
    expect(envelope).not.toContain("private-key");
  });

  it("marks repository stack frames as in-app for Sentry grouping and source links", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const fetchImpl: typeof fetch = (async (_url, init) => {
      calls.push({ init: init as RequestInit });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    const client = createSentryClient({
      dsn: "https://public@example.sentry.io/12345",
      service: "test-service",
      fetchImpl,
    });
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at run (/opt/render/project/src/apps/delivery-service/src/server.ts:42:7)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
    ].join("\n");

    await client.captureException(error);

    const envelope = String(calls[0]?.init.body).trim().split("\n");
    const payload = JSON.parse(envelope[2] ?? "{}") as {
      exception?: { values?: Array<{ stacktrace?: { frames?: Array<Record<string, unknown>> } }> };
    };
    const frames = payload.exception?.values?.[0]?.stacktrace?.frames ?? [];
    expect(frames.find((frame) => frame.filename === "/opt/render/project/src/apps/delivery-service/src/server.ts")?.in_app).toBe(true);
    expect(frames.find((frame) => frame.filename === "node:internal/process/task_queues")?.in_app).toBe(false);
  });

  it("returns null when SENTRY_DSN is unset", () => {
    expect(sentryClientFromEnv({}, "svc")).toBeNull();
  });

  it("uses a Cloudflare version tag as the release", async () => {
    const calls: RequestInit[] = [];
    const client = sentryClientFromEnv(
      {
        SENTRY_DSN: "https://public@example.sentry.io/12345",
        CF_VERSION_METADATA: { id: "worker-version-id", tag: "git-sha" },
      },
      "worker",
      {
        fetchImpl: (async (_url, init) => {
          calls.push(init as RequestInit);
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      },
    );

    await client?.captureMessage("release probe");

    expect(calls[0]?.body).toContain("\"release\":\"git-sha\"");
  });

  it("sends successful tracing transactions without creating error events", async () => {
    const calls: RequestInit[] = [];
    const client = createSentryClient({
      dsn: "https://public@example.sentry.io/12345",
      service: "dashboard",
      environment: "production",
      release: "release-sha",
      now: () => new Date("2026-07-09T23:00:00.000Z"),
      fetchImpl: (async (_url, init) => {
        calls.push(init as RequestInit);
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    });

    await client.captureTransaction({
      name: "ops.sentry.transport",
      op: "ops.smoke",
      tags: { component: "ops_sentry_transport" },
    });

    const envelope = String(calls[0]?.body).trim().split("\n");
    expect(JSON.parse(envelope[1] ?? "{}")).toEqual({ type: "transaction" });
    const payload = JSON.parse(envelope[2] ?? "{}") as Record<string, unknown> & {
      contexts?: { trace?: Record<string, unknown> };
      tags?: Record<string, unknown>;
    };
    expect(payload).toMatchObject({
      type: "transaction",
      transaction: "ops.sentry.transport",
      transaction_info: { source: "custom" },
      start_timestamp: "2026-07-09T23:00:00.000Z",
      timestamp: "2026-07-09T23:00:00.000Z",
      environment: "production",
      release: "release-sha",
      spans: [],
    });
    expect(payload.tags).toMatchObject({ service: "dashboard", component: "ops_sentry_transport" });
    expect(payload.contexts?.trace).toMatchObject({ op: "ops.smoke", status: "ok" });
    expect(String(payload.contexts?.trace?.trace_id)).toMatch(/^[0-9a-f]{32}$/);
    expect(String(payload.contexts?.trace?.span_id)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects a transaction when Sentry does not accept the envelope", async () => {
    const client = createSentryClient({
      dsn: "https://public@example.sentry.io/12345",
      service: "dashboard",
      fetchImpl: (async () => new Response(null, { status: 503 })) as typeof fetch,
    });

    await expect(client.captureTransaction({ name: "ops.sentry.transport", op: "ops.smoke" }))
      .rejects.toThrow("sentry_send_failed status=503");
  });

  it("captureException swallows Sentry transport failures", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(captureException({
      async captureException() {
        throw new Error("network");
      },
      async captureMessage() {},
    }, new Error("app"))).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("can be installed with a null client", () => {
    expect(() => installNodeSentryHandlers(null)).not.toThrow();
  });
});

describe("isCloudflareQueueOverloadError (AXE-65)", () => {
  it("matches the canonical native-binding throw", () => {
    expect(
      isCloudflareQueueOverloadError(new Error("Queue is overloaded. Please back off. (10250)")),
    ).toBe(true);
  });

  it("matches the HTTP API JSON-body excerpt", () => {
    expect(
      isCloudflareQueueOverloadError(
        new Error('[pull] HTTP 429: {"success":false,"errors":[{"code":10250,"message":"Queue is overloaded"}]}'),
      ),
    ).toBe(true);
  });

  it("matches a bare string error", () => {
    expect(isCloudflareQueueOverloadError("Queue is overloaded")).toBe(true);
    expect(isCloudflareQueueOverloadError("rate limited: 10250")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCloudflareQueueOverloadError(new Error("Authentication error"))).toBe(false);
    expect(isCloudflareQueueOverloadError(new Error("connection reset"))).toBe(false);
    expect(isCloudflareQueueOverloadError(null)).toBe(false);
    expect(isCloudflareQueueOverloadError(undefined)).toBe(false);
    // Don't match a longer code like 102500 that happens to contain 10250.
    expect(isCloudflareQueueOverloadError(new Error("error 102500: something else"))).toBe(false);
  });
});

describe("isCloudflareQueueInternalError (ROL-305)", () => {
  it.each([
    "Unknown Internal Error (15000)",
    'Queue send failed: {"success":false,"errors":[{"code":15000}]}',
  ])("matches %s", (message) => {
    expect(isCloudflareQueueInternalError(new Error(message))).toBe(true);
  });

  it("does not match overload or application failures", () => {
    expect(isCloudflareQueueInternalError("Queue is overloaded. Please back off. (10250)")).toBe(false);
    expect(isCloudflareQueueInternalError("Internal error: workspace not found")).toBe(false);
    expect(isCloudflareQueueInternalError(null)).toBe(false);
  });
});

describe("isCircuitBreakerOpenError (AXE-93)", () => {
  it("matches the canonical delivery_service_503 body excerpt", () => {
    expect(
      isCircuitBreakerOpenError(
        new Error(
          'delivery_service_503: {"ok":false,"status":"retry","latency_ms":0,"response":{"skipped_by":"circuit_breaker","reason":"breaker_open_cooldown_active"}}',
        ),
      ),
    ).toBe(true);
  });

  it("matches just the reason token (defensive against body truncation)", () => {
    expect(isCircuitBreakerOpenError(new Error("…breaker_open_cooldown_active…"))).toBe(true);
  });

  it("matches skipped_by + circuit_breaker (defensive against future reasons)", () => {
    expect(
      isCircuitBreakerOpenError(
        new Error('delivery_service_503: {"skipped_by":"circuit_breaker","reason":"breaker_half_open_test_failed"}'),
      ),
    ).toBe(true);
  });

  it("matches a bare string error", () => {
    expect(isCircuitBreakerOpenError("breaker_open_cooldown_active")).toBe(true);
  });

  it("does not match unrelated errors", () => {
    expect(isCircuitBreakerOpenError(new Error("Authentication error"))).toBe(false);
    expect(isCircuitBreakerOpenError(new Error("Queue is overloaded (10250)"))).toBe(false);
    expect(isCircuitBreakerOpenError(new Error("delivery_service_503: 502 Bad Gateway"))).toBe(false);
    expect(isCircuitBreakerOpenError(null)).toBe(false);
    expect(isCircuitBreakerOpenError(undefined)).toBe(false);
  });
});

describe("isTransientPostgresError (AXE-95..113)", () => {
  // Real Sentry messages from the 2026-05-20T01:54 Supabase pooler restart.
  it.each([
    "connect ECONNREFUSED 10.205.213.64:5432",
    "connect ETIMEDOUT 35.227.164.209:5432",
    "read ECONNRESET",
    "read ECONNABORTED",
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout exceeded when trying to connect",
    "write CONNECT_TIMEOUT dpg-d7rkgp67r5hc739ee6ug-a.oregon-postgres.render.com:5432",
    "write CONNECTION_CLOSED dpg-d7rkgp67r5hc739ee6ug-a.oregon-postgres.render.com:5432",
    "proxy request failed, cannot connect to the specified address",
    "the database system is starting up",
    "the database system is not yet accepting connections",
    "the database system is shutting down",
    "server closed the connection unexpectedly",
    "Connection ended",
  ])("matches %s", (msg) => {
    expect(isTransientPostgresError(new Error(msg))).toBe(true);
  });

  it("matches bare-string errors (pg sometimes throws strings)", () => {
    expect(isTransientPostgresError("ECONNREFUSED 5432")).toBe(true);
  });

  it("does not match application errors that look superficially similar", () => {
    // These must continue to reach Sentry — they're real bugs, not infra noise.
    expect(isTransientPostgresError(new Error('column "engine" does not exist'))).toBe(false);
    expect(isTransientPostgresError(new Error('relation "data_contracts" does not exist'))).toBe(false);
    expect(isTransientPostgresError(new Error("Authentication error"))).toBe(false);
    expect(isTransientPostgresError(new Error("Queue is overloaded (10250)"))).toBe(false);
    expect(isTransientPostgresError(new Error("breaker_open_cooldown_active"))).toBe(false);
    expect(isTransientPostgresError(null)).toBe(false);
    expect(isTransientPostgresError(undefined)).toBe(false);
    expect(isTransientPostgresError("")).toBe(false);
  });
});

describe("isPoolAcquireTimeout (storm guard)", () => {
  it("matches the pg pool acquire timeout", () => {
    expect(isPoolAcquireTimeout(new Error("timeout exceeded when trying to connect"))).toBe(true);
    expect(isPoolAcquireTimeout("timeout exceeded when trying to connect")).toBe(true);
  });

  it("does NOT match connection-blip transients (those should still retry)", () => {
    expect(isPoolAcquireTimeout(new Error("ECONNREFUSED 5432"))).toBe(false);
    expect(isPoolAcquireTimeout(new Error("Connection terminated unexpectedly"))).toBe(false);
    expect(isPoolAcquireTimeout(null)).toBe(false);
    expect(isPoolAcquireTimeout(undefined)).toBe(false);
  });
});

describe("withPgRetry", () => {
  it("returns the result with no retry on success", async () => {
    let calls = 0;
    const result = await withPgRetry("t", async () => {
      calls++;
      return 42;
    });
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it("retries once on a connection-blip transient (ECONNRESET)", async () => {
    let calls = 0;
    const result = await withPgRetry(
      "t",
      async () => {
        calls++;
        if (calls === 1) throw new Error("ECONNRESET");
        return "ok";
      },
      { backoffMs: 0 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });

  it("FAILS FAST on a pool-acquire timeout — no in-process retry (storm guard)", async () => {
    let calls = 0;
    await expect(
      withPgRetry(
        "t",
        async () => {
          calls++;
          throw new Error("timeout exceeded when trying to connect");
        },
        { backoffMs: 0 },
      ),
    ).rejects.toThrow("timeout exceeded when trying to connect");
    expect(calls).toBe(1); // not retried — sheds instead of amplifying the storm
  });

  it("does not retry non-transient (application) errors", async () => {
    let calls = 0;
    await expect(
      withPgRetry("t", async () => {
        calls++;
        throw new Error('column "x" does not exist');
      }),
    ).rejects.toThrow("does not exist");
    expect(calls).toBe(1);
  });
});

describe("isTransientFetchError (AXE-114/115)", () => {
  it.each([
    "TypeError: fetch failed",
    "fetch failed",
    "network error",
    "socket hang up",
    "read ECONNRESET",
    "ETIMEDOUT",
    "AbortError: This operation was aborted",
    "UND_ERR_SOCKET",
    // Workers runtime wording when a subrequest connection drops (JAVASCRIPT-2N).
    "Network connection lost.",
  ])("matches %s", (msg) => {
    expect(isTransientFetchError(new Error(msg))).toBe(true);
  });

  it("does not match application failures", () => {
    expect(isTransientFetchError(new Error("HTTP 401: Authentication error"))).toBe(false);
    expect(isTransientFetchError(new Error("breaker_open_cooldown_active"))).toBe(false);
    expect(isTransientFetchError(null)).toBe(false);
    expect(isTransientFetchError(undefined)).toBe(false);
  });
});

describe("isTransientPlatformHttpError", () => {
  it.each([
    "[pull] HTTP 500: Unknown Internal Error /opt/render/project/src/index.js",
    "[pull] HTTP 502: Bad Gateway",
    "[pull] HTTP 503: Service Unavailable",
    "r2_get_504: Gateway Timeout",
    "r2_put_500: Cloudflare internal server error",
    'retry re-enqueue failed: HTTP 504 {"errors":[{"message":"Upstream service unavailable"}]}',
    "ClickHouse query failed (502): <!DOCTYPE html>",
    // Query timeouts are transient — no HTTP status, matched before the status gate.
    "data-contracts-drift: ClickHouse query timed out after 8000ms",
    // Cloudflare edge errors: the status alone settles it, since the body is
    // an HTML page rather than a JSON API error (JAVASCRIPT-38).
    "r2_get_521: <cloudflare html error: Web server is down>",
    "r2_get_520: <cloudflare html error>",
    "r2_put_522: <cloudflare html error: Connection timed out>",
    "r2_get_524: <cloudflare html error>",
    "r2_delete_525: <cloudflare html error: SSL handshake failed>",
    "r2_get_527: <cloudflare html error>",
    "r2_get_530: <cloudflare html error>",
    "[pull] HTTP 521: <cloudflare html error: Web server is down>",
  ])("matches %s", (msg) => {
    expect(isTransientPlatformHttpError(new Error(msg))).toBe(true);
  });

  it("does not match unrelated application failures", () => {
    expect(isTransientPlatformHttpError(new Error("HTTP 400: bad request"))).toBe(false);
    // 528/529 are not part of Cloudflare's edge-error family.
    expect(isTransientPlatformHttpError(new Error("r2_get_528: nope"))).toBe(false);
    expect(isTransientPlatformHttpError(new Error("HTTP 529: nope"))).toBe(false);
    expect(isTransientPlatformHttpError(new Error("HTTP 401: Authentication error"))).toBe(false);
    expect(isTransientPlatformHttpError(new Error("HTTP 500: application validation failed"))).toBe(false);
    expect(isTransientPlatformHttpError(null)).toBe(false);
    expect(isTransientPlatformHttpError(undefined)).toBe(false);
  });
});

describe("isTransientR2Error (AXE-149)", () => {
  it.each([
    "put: We encountered an internal error. Please try again. (10001)",
    "get: We encountered an internal error. Please try again. (10002)",
    "We encountered an internal error. Please try again.",
    "put: Please look at https://www.cloudflarestatus.com for issues or contact customer support. (10043)",
    "put: Reduce your concurrent request rate for the same object. (10058)",
    "get: Reduce your rate of simultaneous reads on the same object. (10058)",
    "r2_get_429: ",
    "r2_put_429: rate limited",
    "r2_delete_429: rate limited",
    // Body shorter than its own content-length — the read was cut (JAVASCRIPT-3M).
    "r2_get_truncated: queue-spill/ws-1/evt-1/dst-1/1.json (65536/131072 bytes)",
  ])("matches %s", (msg) => {
    expect(isTransientR2Error(new Error(msg))).toBe(true);
  });

  it("does not match application failures or unrelated 'internal error' wording", () => {
    expect(isTransientR2Error(new Error("HTTP 401: Authentication error"))).toBe(false);
    expect(isTransientR2Error(new Error("Internal error: workspace not found"))).toBe(false);
    expect(isTransientR2Error(new Error("Queue is overloaded. Please back off. (10250)"))).toBe(false);
    expect(isTransientR2Error(new Error("r2_get_401: unauthorized"))).toBe(false);
    expect(isTransientR2Error(null)).toBe(false);
    expect(isTransientR2Error(undefined)).toBe(false);
    expect(isTransientR2Error("")).toBe(false);
  });
});
