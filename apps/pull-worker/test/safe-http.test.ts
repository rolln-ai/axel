import http from "node:http";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  InMemoryPullRecordSink,
  InMemoryPullStateStore,
  runPullSync,
  type HttpFetch,
  type PullSource,
} from "@axel/pull-connectors";
import { defaultPullConnectorRegistry } from "../src/index.js";
import { closeSafePullHttpDispatcher, safePullHttpFetch } from "../src/safe-http.js";

afterAll(async () => {
  await closeSafePullHttpDispatcher();
});

describe("pull-worker safe HTTP", () => {
  it("sends no credential bytes to a loopback target", async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.end("internal-only");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind TCP");

    await expect(safePullHttpFetch(`http://127.0.0.1:${address.port}/`, {
      method: "GET",
      headers: { authorization: "Basic secret" },
      redirect: "manual",
    })).rejects.toThrow(/ssrf_blocked/);
    expect(requests).toBe(0);

    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });

  it("wires Chargebee through the protected registry fetch and rejects redirects", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn<HttpFetch>(async (_url, init) => {
      expect(init.redirect).toBe("manual");
      return {
        status: 302,
        headers: { get: (name) => name.toLowerCase() === "location" ? "https://attacker.example/" : null },
        body: { cancel },
        text: vi.fn(async () => "payload=must-not-be-read"),
      };
    });
    const connector = defaultPullConnectorRegistry(fetchImpl).get("chargebee");
    if (!connector) throw new Error("Chargebee connector missing");
    const source: PullSource<Record<string, unknown>> = {
      source_id: "src_chargebee",
      workspace_id: "ws_1",
      type: "chargebee",
      name: "Chargebee",
      config: {
        site: "acme-test",
        api_key: "test_key",
        streams: [{ name: "customers" }],
      },
    };

    const summary = await runPullSync({
      source,
      connector,
      stateStore: new InMemoryPullStateStore(),
      sink: new InMemoryPullRecordSink(),
    });

    expect(summary.streams[0]).toMatchObject({ status: "failed", error: "HTTP 302" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/^https:\/\/acme-test\.chargebee\.com\//);
    expect(fetchImpl.mock.calls[0]?.[1].headers.authorization).toBe("Basic dGVzdF9rZXk6");
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("attacker.example"))).toBe(false);
  });

  it("wires Shopify through the protected registry fetch and never follows an access-token redirect", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn<HttpFetch>(async (_url, init) => {
      expect(init.redirect).toBe("manual");
      return {
        status: 302,
        headers: { get: (name) => name.toLowerCase() === "location" ? "https://attacker.example/" : null },
        body: { cancel },
        text: vi.fn(async () => "payload=must-not-be-read"),
      };
    });
    const connector = defaultPullConnectorRegistry(fetchImpl).get("shopify");
    if (!connector) throw new Error("Shopify connector missing");
    const source: PullSource<Record<string, unknown>> = {
      source_id: "src_shopify",
      workspace_id: "ws_1",
      type: "shopify",
      name: "Shopify",
      config: {
        shop: "acme-test.myshopify.com",
        access_token: "shopify_test_token",
        streams: [{ name: "orders" }],
      },
    };

    const summary = await runPullSync({
      source,
      connector,
      stateStore: new InMemoryPullStateStore(),
      sink: new InMemoryPullRecordSink(),
    });

    expect(summary.streams[0]).toMatchObject({ status: "failed", error: "HTTP 302" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/^https:\/\/acme-test\.myshopify\.com\//);
    expect(fetchImpl.mock.calls[0]?.[1].headers["x-shopify-access-token"]).toBe("shopify_test_token");
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("attacker.example"))).toBe(false);
  });

  it("wires Stripe through the protected registry fetch and never follows a bearer redirect", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn<HttpFetch>(async (_url, init) => {
      expect(init.redirect).toBe("manual");
      return {
        status: 302,
        headers: { get: (name) => name.toLowerCase() === "location" ? "https://attacker.example/" : null },
        body: { cancel },
        text: vi.fn(async () => "payload=must-not-be-read"),
      };
    });
    const connector = defaultPullConnectorRegistry(fetchImpl).get("stripe");
    if (!connector) throw new Error("Stripe connector missing");
    const source: PullSource<Record<string, unknown>> = {
      source_id: "src_stripe",
      workspace_id: "ws_1",
      type: "stripe",
      name: "Stripe",
      config: {
        api_key: "sk_test_123",
        streams: [{ name: "customers" }],
      },
    };

    const summary = await runPullSync({
      source,
      connector,
      stateStore: new InMemoryPullStateStore(),
      sink: new InMemoryPullRecordSink(),
    });

    expect(summary.streams[0]).toMatchObject({ status: "failed", error: "HTTP 302" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/^https:\/\/api\.stripe\.com\//);
    expect(fetchImpl.mock.calls[0]?.[1].headers.authorization).toBe("Bearer sk_test_123");
    expect(fetchImpl.mock.calls.some(([url]) => url.includes("attacker.example"))).toBe(false);
  });
});
