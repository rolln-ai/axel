import { describe, expect, it } from "vitest";
import {
  buildShopifyListUrl,
  createShopifyConnector,
  InMemoryPullRecordSink,
  InMemoryPullStateStore,
  runPullSync,
  type HttpFetch,
  type PullSource,
} from "../src/index";

const SOURCE: PullSource<{ shop: string; access_token: string; streams?: Array<{ name: string }> }> = {
  source_id: "src_sh",
  workspace_id: "ws_1",
  type: "shopify",
  name: "Shopify",
  config: {
    shop: "acme.myshopify.com",
    access_token: "shpat_123",
    streams: [{ name: "orders" }],
  },
};

describe("Shopify pull connector", () => {
  it("builds incremental REST URLs with updated_at_min", () => {
    const url = buildShopifyListUrl(
      SOURCE,
      "orders",
      { name: "orders", cursor_field: "updated_at", sync_mode: "incremental" },
      { value: "2026-05-08T12:00:00Z" },
    );
    // Inclusive watermark (exact, not +1s) so whole-second updated_at ties at a
    // page boundary aren't skipped; re-fetched boundary rows dedup downstream.
    expect(url).toBe("https://acme.myshopify.com/admin/api/2026-04/orders.json?limit=250&updated_at_min=2026-05-08T12%3A00%3A00.000Z");
  });

  it("emits records and follows Link header pagination", async () => {
    const urls: string[] = [];
    const nextUrl = "https://acme.myshopify.com/admin/api/2026-04/orders.json?page_info=abc&limit=250";
    const fetchImpl: HttpFetch = async (url) => {
      urls.push(url);
      if (!url.includes("page_info=abc")) {
        return jsonResponse(
          { orders: [{ id: 1, updated_at: "2026-05-08T12:00:00Z" }] },
          `<${nextUrl}>; rel="next"`,
        );
      }
      return jsonResponse({ orders: [{ id: 2, updated_at: "2026-05-08T12:00:02Z" }] });
    };
    const sink = new InMemoryPullRecordSink();
    const summary = await runPullSync(
      { source: SOURCE, connector: createShopifyConnector(fetchImpl), stateStore: new InMemoryPullStateStore(), sink },
      { now: fixedNow },
    );
    expect(urls[1]).toBe(nextUrl);
    expect(sink.records.map((record) => record.record_id)).toEqual(["1", "2"]);
    expect(summary.streams[0]).toMatchObject({ records: 2, pages: 2, cursor: { value: "2026-05-08T12:00:02Z" } });
  });

  it("refuses to follow a Link cursor pointing at a foreign host (SSRF / token-exfil guard)", async () => {
    // A poisoned `rel=next` Link sends pagination to an attacker host. The
    // connector attaches the shop access token, so following it would leak the
    // token. The connector must reject the off-host cursor instead.
    const evilUrl = "https://attacker.example.com/steal?limit=250";
    const requestedUrls: string[] = [];
    const fetchImpl: HttpFetch = async (url, init) => {
      requestedUrls.push(url);
      // The token must NEVER be sent to the attacker host.
      if (new URL(url).hostname === "attacker.example.com") {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        throw new Error(`token leaked to attacker host with header: ${headers["x-shopify-access-token"] ?? "none"}`);
      }
      return jsonResponse({ orders: [{ id: 1, updated_at: "2026-05-08T12:00:00Z" }] }, `<${evilUrl}>; rel="next"`);
    };
    const sink = new InMemoryPullRecordSink();
    const summary = await runPullSync(
      { source: SOURCE, connector: createShopifyConnector(fetchImpl), stateStore: new InMemoryPullStateStore(), sink },
      { now: fixedNow },
    );
    // The stream fails (guard threw) rather than dialing the attacker host.
    expect(summary.streams[0]?.status).toBe("failed");
    expect(summary.streams[0]?.error).toMatch(/does not match shop|not a valid URL/);
    expect(requestedUrls.some((url) => new URL(url).hostname === "attacker.example.com")).toBe(false);
  });
});

function jsonResponse(body: unknown, link: string | null = null) {
  return {
    status: 200,
    headers: { get: (name: string) => name.toLowerCase() === "link" ? link : null },
    text: async () => JSON.stringify(body),
  };
}

function fixedNow() {
  return new Date("2026-05-08T12:00:00.000Z");
}
