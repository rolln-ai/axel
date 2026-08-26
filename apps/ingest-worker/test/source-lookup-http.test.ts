import { afterEach, describe, expect, it, vi } from "vitest";
import type { Source } from "@axel/shared";
import { lookupSourceUncached, type Env } from "../src/index.js";
import { SourceLookupUnavailableError } from "../src/source-lookup-error.js";
import {
  lookupSourceFromDeliveryService,
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
    vi.unstubAllGlobals();
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
