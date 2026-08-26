import { describe, expect, it } from "vitest";
import {
  buildChargebeeListUrl,
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
