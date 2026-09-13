import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@axel/shared";
import { lookupSourceUncached, type Env } from "../src/index.js";
import { SourceLookupUnavailableError } from "../src/source-lookup-error.js";
import {
  lookupSourceFromDeliveryService,
  SOURCE_LOOKUP_TIMEOUT_MS,
  type SourceLookupFetch,
} from "../src/source-lookup-http.js";

const ENV = {
  DELIVERY_SERVICE_URL: "https://delivery.example/",
  SOURCE_LOOKUP_SHARED_SECRET: "source-lookup-secret", // gitleaks:allow
  DELIVERY_SHARED_SECRET: "delivery-shared-secret", // gitleaks:allow
};

const SOURCE: Source = {
  source_id: "src_1",
  workspace_id: "ws_1",
  name: "Complete source",
  secret_token: "token-hash",
  status: "active",
  max_body_bytes: 4096,
  max_body_depth: 20,
  max_events_per_minute: 120,
  provider: "chargebee",
  signing_secret: "current-secret", // gitleaks:allow
  signing_secret_previous: "previous-secret", // gitleaks:allow
  redact_paths: ["customer.email"],
  inbound_ip_allowlist: ["10.0.0.0/8"],
  ordering_enabled: true,
  ordering_key_header: "x-order-key",
  ordering_key_path: "customer.id",
  subject_key_paths: [{ loc: "query", path: "customer_id", kind: "id" }],
  field_selection: ["customer.id", "amount"],
};

function response(body: unknown, status: number = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("delivery-service source lookup client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([500, 502, 503, 504])("retries an HTTP %s once and returns freshly loaded authorization", async (status) => {
    const fetchMock = vi.fn<SourceLookupFetch>()
      .mockResolvedValueOnce(response({ error: "temporary" }, status))
      .mockResolvedValueOnce(response({ source: SOURCE }));
    await expect(lookupSourceFromDeliveryService(ENV, "src_1", fetchMock)).resolves.toEqual(SOURCE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1].body).toBe(fetchMock.mock.calls[0]?.[1].body);
  });

  it.each([401, 403, 404, 429])("does not retry HTTP %s", async (status) => {
    const fetchMock = vi.fn<SourceLookupFetch>().mockResolvedValue(response({ error: "rejected" }, status));
    await expect(lookupSourceFromDeliveryService(ENV, "src_1", fetchMock))
      .rejects.toMatchObject({ reason: "lookup_http", httpStatus: status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recovers when the first request times out", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<SourceLookupFetch>()
      .mockImplementationOnce(async () => new Promise<Response>(() => {}))
      .mockResolvedValueOnce(response({ source: SOURCE }));
    const result = lookupSourceFromDeliveryService(ENV, "src_1", fetchMock);
    const assertion = expect(result).resolves.toEqual(SOURCE);
    await vi.advanceTimersByTimeAsync(SOURCE_LOOKUP_TIMEOUT_MS + 100);
    await assertion;
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled response body as well as response headers", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<SourceLookupFetch>().mockImplementation(async () =>
      new Response(new ReadableStream({ start() {} })));
    const result = lookupSourceFromDeliveryService(ENV, "src_1", fetchMock);
    const assertion = expect(result).rejects.toMatchObject({ reason: "lookup_timeout" });
    await vi.advanceTimersByTimeAsync(SOURCE_LOOKUP_TIMEOUT_MS * 2 + 100);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry invalid JSON or expose its contents", async () => {
    const fetchMock = vi.fn<SourceLookupFetch>().mockResolvedValue(response("secret upstream response"));
    await expect(lookupSourceFromDeliveryService(ENV, "src_1", fetchMock))
      .rejects.toMatchObject({ reason: "lookup_invalid_response", message: "delivery-service source lookup returned invalid JSON" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("authenticates the request and preserves every Source field", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ source: SOURCE })
    ));

    const result = await lookupSourceFromDeliveryService(
      ENV,
      "src_1",
      fetchMock as SourceLookupFetch,
    );

    expect(result).toEqual(SOURCE);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://delivery.example/internal/source");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-axel-shared-secret": "source-lookup-secret",
      },
      body: JSON.stringify({ source_id: "src_1" }),
    });
  });

  it("falls back to delivery auth only while dedicated source auth is absent", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ source: SOURCE })
    ));

    await lookupSourceFromDeliveryService(
      {
        DELIVERY_SERVICE_URL: ENV.DELIVERY_SERVICE_URL,
        DELIVERY_SHARED_SECRET: ENV.DELIVERY_SHARED_SECRET,
      },
      "src_1",
      fetchMock as SourceLookupFetch,
    );

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        "x-axel-shared-secret": "delivery-shared-secret",
      },
    });
  });

  it("returns null only for an explicit validated source miss", async () => {
    await expect(lookupSourceFromDeliveryService(
      ENV,
      "src_missing",
      (async () => response({ source: null })) as SourceLookupFetch,
    )).resolves.toBeNull();
  });

  it.each([
    ["network failure", async () => { throw new Error("connect failed"); }],
    ["server failure", async () => response({ error: "internal" }, 503)],
    ["deployment skew 404", async () => response({ error: "not_found" }, 404)],
    ["invalid JSON", async () => response("not-json")],
    ["missing source envelope", async () => response({ ok: true })],
    ["invalid source shape", async () => response({ source: { source_id: "src_1" } })],
    ["mismatched source id", async () => response({ source: { ...SOURCE, source_id: "src_other" } })],
  ])("treats %s as transient and non-cacheable", async (_label, fetchImpl) => {
    await expect(lookupSourceFromDeliveryService(
      ENV,
      "src_1",
      fetchImpl as SourceLookupFetch,
    )).rejects.toBeInstanceOf(SourceLookupUnavailableError);
  });

  it("fails transiently when the delivery lookup configuration is incomplete", async () => {
    await expect(lookupSourceFromDeliveryService(
      { DELIVERY_SERVICE_URL: ENV.DELIVERY_SERVICE_URL },
      "src_1",
    )).rejects.toBeInstanceOf(SourceLookupUnavailableError);
  });

  it.each([
    "http://delivery.example",
    "https://user:password@delivery.example",
    "https://delivery.example/prefix",
    "https://delivery.example?target=other",
  ])("rejects an unsafe service URL before sending the credential: %s", async (url) => {
    const fetchMock = vi.fn();
    await expect(lookupSourceFromDeliveryService(
      { ...ENV, DELIVERY_SERVICE_URL: url },
      "src_1",
      fetchMock as SourceLookupFetch,
    )).rejects.toBeInstanceOf(SourceLookupUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized source response", async () => {
    await expect(lookupSourceFromDeliveryService(
      ENV,
      "src_1",
      (async () => response({ padding: "x".repeat(1024 * 1024) })) as SourceLookupFetch,
    )).rejects.toBeInstanceOf(SourceLookupUnavailableError);
  });

  it("wires production cache misses through HTTP even when DATABASE_URL exists", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ source: SOURCE })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      ...ENV,
      DATABASE_URL: "postgres://must-not-be-used.example/db",
    } as unknown as Env;

    await expect(lookupSourceUncached(env, "src_1")).resolves.toEqual(SOURCE);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not require delivery auth when dedicated source auth is configured", async () => {
    const fetchMock = vi.fn(async (_input: string, _init: RequestInit) => (
      response({ source: SOURCE })
    ));
    vi.stubGlobal("fetch", fetchMock);
    const env = {
      DELIVERY_SERVICE_URL: ENV.DELIVERY_SERVICE_URL,
      SOURCE_LOOKUP_SHARED_SECRET: ENV.SOURCE_LOOKUP_SHARED_SECRET,
    } as unknown as Env;

    await expect(lookupSourceUncached(env, "src_1")).resolves.toEqual(SOURCE);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not silently fall back to direct Postgres in production", async () => {
    const env = {
      DATABASE_URL: "postgres://must-not-be-used.example/db",
    } as unknown as Env;

    await expect(lookupSourceUncached(env, "src_1"))
      .rejects.toBeInstanceOf(SourceLookupUnavailableError);
  });
});
