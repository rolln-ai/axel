import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureDashboardExceptionAndFlush = vi.hoisted(() => vi.fn());

vi.mock("../lib/sentry-capture", () => ({
  captureDashboardExceptionAndFlush,
}));

import { POST } from "../app/api/ops/sentry-test/route";

const ORIGINAL_ENV = {
  OPS_TEST_TOKEN: process.env.OPS_TEST_TOKEN,
  SENTRY_DSN: process.env.SENTRY_DSN,
  NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
  SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
  SENTRY_RELEASE: process.env.SENTRY_RELEASE,
};

function request(token?: string, mode?: "source-map"): Request {
  const url = new URL("https://app.axelapp.ai/api/ops/sentry-test");
  if (mode) url.searchParams.set("mode", mode);
  return new Request(url, {
    method: "POST",
    ...(token ? { headers: { "x-axel-ops-token": token } } : {}),
  });
}

describe("operator Sentry transport probe", () => {
  beforeEach(() => {
    process.env.OPS_TEST_TOKEN = "ops-secret";
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    process.env.SENTRY_ENVIRONMENT = "production";
    process.env.SENTRY_RELEASE = "release-sha";
    captureDashboardExceptionAndFlush.mockReset();
    captureDashboardExceptionAndFlush.mockResolvedValue(
      "0123456789abcdef0123456789abcdef",
    );
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hides the route and does not contact Sentry when auth fails", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("wrong"));

    expect(response.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Sentry is not configured", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("ops-secret"));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: "sentry_not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns success only after Sentry accepts a transaction envelope", async () => {
    process.env.SENTRY_DSN = "https://public@example.sentry.io/12345";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("ops-secret"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const envelope = String(fetchMock.mock.calls[0]?.[1]?.body).trim().split("\n");
    expect(JSON.parse(envelope[1] ?? "{}")).toEqual({ type: "transaction" });
    expect(JSON.parse(envelope[2] ?? "{}")).toMatchObject({
      type: "transaction",
      transaction: "ops.sentry.transport",
      environment: "production",
      release: "release-sha",
    });
    expect(captureDashboardExceptionAndFlush).not.toHaveBeenCalled();
  });

  it("surfaces a rejected Sentry envelope to the deployment smoke", async () => {
    process.env.SENTRY_DSN = "https://public@example.sentry.io/12345";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 })),
    );

    const response = await POST(request("ops-secret"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "sentry_transport_failed" });
  });

  it("captures and flushes a deterministic handled error in source-map mode", async () => {
    process.env.SENTRY_DSN = "https://public@example.sentry.io/12345";
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request("ops-secret", "source-map"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      event_id: "0123456789abcdef0123456789abcdef",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(captureDashboardExceptionAndFlush).toHaveBeenCalledOnce();
    const [error, context] = captureDashboardExceptionAndFlush.mock.calls[0] ?? [];
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ message: "ops_sentry_source_map_probe" });
    expect(context).toEqual({
      tags: {
        component: "ops_sentry_source_map",
        route: "/api/ops/sentry-test",
      },
    });
  });

  it("fails the source-map probe when the official SDK cannot flush", async () => {
    process.env.SENTRY_DSN = "https://public@example.sentry.io/12345";
    captureDashboardExceptionAndFlush.mockRejectedValueOnce(new Error("flush timeout"));

    const response = await POST(request("ops-secret", "source-map"));

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      ok: false,
      error: "sentry_source_map_failed",
    });
  });

  it("keeps source-map mode hidden when the operator token is invalid", async () => {
    process.env.SENTRY_DSN = "https://public@example.sentry.io/12345";

    const response = await POST(request("wrong", "source-map"));

    expect(response.status).toBe(404);
    expect(captureDashboardExceptionAndFlush).not.toHaveBeenCalled();
  });
});
