import { describe, expect, it, vi } from "vitest";
import {
  buildChargebeeListUrl,
  chargebeeApiBaseUrl,
  createChargebeeConnector,
  InMemoryPullRecordSink,
  InMemoryPullStateStore,
  runPullSync,
  type HttpFetch,
  type PullSource,
} from "../src/index.js";

const SOURCE: PullSource<{ site: string; api_key: string; streams?: Array<{ name: string }> }> = {
  source_id: "src_cb",
  workspace_id: "ws_1",
  type: "chargebee",
  name: "Chargebee",
  config: {
    site: "acme-test",
    api_key: "test_key",
    streams: [{ name: "customers" }],
  },
};

describe("Chargebee pull connector", () => {
  it("only builds API origins under a valid Chargebee tenant hostname", () => {
    expect(chargebeeApiBaseUrl("Acme-Test")).toBe("https://acme-test.chargebee.com");
    expect(chargebeeApiBaseUrl("https://acme-test.chargebee.com/", "chargebee.com"))
      .toBe("https://acme-test.chargebee.com");

    for (const site of ["-acme", "acme-", "acme.example", "a".repeat(64)]) {
      expect(() => chargebeeApiBaseUrl(site)).toThrow(/valid tenant name/);
    }
    expect(() => chargebeeApiBaseUrl("acme", "attacker.example"))
      .toThrow(/custom API domains are not supported/);
  });

  it("rejects a legacy custom domain before preparing a request", async () => {
    const fetchImpl = vi.fn<HttpFetch>();
    const summary = await runPullSync(
      {
        source: {
          ...SOURCE,
          config: { ...SOURCE.config, domain: "attacker.example" },
        },
        connector: createChargebeeConnector(fetchImpl),
        stateStore: new InMemoryPullStateStore(),
        sink: new InMemoryPullRecordSink(),
      },
      { now: fixedNow },
    );

    expect(summary.streams[0]).toMatchObject({
      status: "failed",
      error: "operation_failed",
    });
    expect(JSON.stringify(summary)).not.toContain("attacker.example");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow redirects or forward the Basic credential", async () => {
    const cancel = vi.fn(async () => undefined);
    const readBody = vi.fn(async () =>
      'payload={"email":"victim@example.com"} api_key=sk_live_response_secret'
    );
    const calls: Array<{
      url: string;
      authorization: string | undefined;
      redirect: "manual" | undefined;
    }> = [];
    const fetchImpl: HttpFetch = async (url, init) => {
      calls.push({
        url,
        authorization: init.headers.authorization,
        redirect: init.redirect,
      });
      return {
        status: 302,
        headers: { get: (name) => name.toLowerCase() === "location" ? "http://127.0.0.1/metadata" : null },
        body: { cancel },
        text: readBody,
      };
    };

    const summary = await runPullSync(
      {
        source: SOURCE,
        connector: createChargebeeConnector(fetchImpl),
        stateStore: new InMemoryPullStateStore(),
        sink: new InMemoryPullRecordSink(),
      },
      { now: fixedNow },
    );

    expect(summary.streams[0]).toMatchObject({
      status: "failed",
      error: "http_error_302",
    });
    expect(JSON.stringify(summary)).not.toContain("127.0.0.1");
    expect(readBody).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(calls).toEqual([{
      url: "https://acme-test.chargebee.com/api/v2/customers?limit=100&sort_by%5Basc%5D=updated_at",
      authorization: "Basic dGVzdF9rZXk6",
      redirect: "manual",
    }]);
    expect(calls.some((call) => call.url.includes("127.0.0.1"))).toBe(false);
  });

  it("does not echo malformed success-body bytes into the stream diagnostic", async () => {
    const responseText = "not-json victim@example.com sk_live_response_secret";
    const summary = await runPullSync(
      {
        source: SOURCE,
        connector: createChargebeeConnector(async () => ({
          status: 200,
          headers: { get: () => null },
          text: async () => responseText,
        })),
        stateStore: new InMemoryPullStateStore(),
        sink: new InMemoryPullRecordSink(),
      },
      { now: fixedNow },
    );

    expect(summary.streams[0]).toMatchObject({
      status: "failed",
      error: "invalid_payload",
    });
    expect(JSON.stringify(summary)).not.toContain("victim@example.com");
    expect(JSON.stringify(summary)).not.toContain("sk_live_response_secret");
  });

  it("builds incremental list URLs with updated_at cursor and offset", () => {
    const url = buildChargebeeListUrl(
      SOURCE,
      "customers",
      { name: "customers", cursor_field: "updated_at", sync_mode: "incremental" },
      { value: 1_700_000_000 },
      "abc",
    );

    expect(url).toBe(
      "https://acme-test.chargebee.com/api/v2/customers?limit=100&sort_by%5Basc%5D=updated_at&updated_at%5Bafter%5D=1700000001&offset=abc",
    );
  });

  it("paginates, emits records, and persists the high watermark", async () => {
    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const fetchImpl: HttpFetch = async (url, init) => {
      calls.push({ url, authorization: init.headers.authorization });
      if (!url.includes("offset=next_1")) {
        return jsonResponse({
          list: [
            { customer: { id: "cus_1", updated_at: 10, email: "a@example.com" } },
            { customer: { id: "cus_2", updated_at: 12, email: "b@example.com" } },
          ],
          next_offset: "next_1",
        });
      }
      return jsonResponse({
        list: [
          { customer: { id: "cus_3", updated_at: 14, email: "c@example.com" } },
        ],
      });
    };

    const stateStore = new InMemoryPullStateStore();
    const sink = new InMemoryPullRecordSink();
    const summary = await runPullSync(
      {
        source: SOURCE,
        connector: createChargebeeConnector(fetchImpl),
        stateStore,
        sink,
      },
      { now: fixedNow },
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.authorization).toBe("Basic dGVzdF9rZXk6");
    expect(calls[1]?.url).toContain("offset=next_1");
    expect(sink.records.map((record) => record.record_id)).toEqual(["cus_1", "cus_2", "cus_3"]);
    expect(summary.streams[0]).toMatchObject({
      stream: "customers",
      records: 3,
      pages: 2,
      cursor: { value: 14 },
      status: "success",
    });
    const serializedSummary = JSON.stringify(summary);
    expect(serializedSummary).not.toContain("cus_1");
    expect(serializedSummary).not.toContain("a@example.com");
    await expect(stateStore.get("src_cb")).resolves.toEqual({
      streams: {
        customers: {
          cursor: { value: 14 },
          // Cleared on a clean drain — no pageset left in flight.
          resumePageCursor: null,
          pendingHighWatermark: null,
          updated_at: "2026-05-08T12:00:00.000Z",
        },
      },
    });
  });

  it("uses prior stream state on the next incremental run", async () => {
    const urls: string[] = [];
    const fetchImpl: HttpFetch = async (url) => {
      urls.push(url);
      return jsonResponse({ list: [] });
    };
    const stateStore = new InMemoryPullStateStore();
    await stateStore.setStreamState("src_cb", "customers", {
      cursor: { value: 99 },
      updated_at: "2026-05-08T11:00:00.000Z",
    });

    await runPullSync(
      {
        source: SOURCE,
        connector: createChargebeeConnector(fetchImpl),
        stateStore,
        sink: new InMemoryPullRecordSink(),
      },
      { now: fixedNow },
    );

    expect(urls[0]).toContain("updated_at%5Bafter%5D=100");
  });

  it("can run a full refresh without sending the prior cursor filter", async () => {
    const urls: string[] = [];
    const fetchImpl: HttpFetch = async (url) => {
      urls.push(url);
      return jsonResponse({ list: [] });
    };
    const stateStore = new InMemoryPullStateStore();
    await stateStore.setStreamState("src_cb", "customers", {
      cursor: { value: 99 },
      updated_at: "2026-05-08T11:00:00.000Z",
    });

    await runPullSync(
      {
        source: {
          ...SOURCE,
          config: {
            ...SOURCE.config,
            streams: [{ name: "customers", sync_mode: "full_refresh" }],
          },
        },
        connector: createChargebeeConnector(fetchImpl),
        stateStore,
        sink: new InMemoryPullRecordSink(),
      },
      { now: fixedNow },
    );

    expect(urls[0]).not.toContain("updated_at%5Bafter%5D");
  });
});

function fixedNow(): Date {
  return new Date("2026-05-08T12:00:00.000Z");
}

function jsonResponse(body: unknown) {
  return {
    status: 200,
    headers: { get: () => null },
    async text() {
      return JSON.stringify(body);
    },
  };
}
