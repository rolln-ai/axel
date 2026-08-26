import { describe, expect, it } from "vitest";
import {
  buildStripeListUrl,
  createStripeConnector,
  InMemoryPullRecordSink,
  InMemoryPullStateStore,
  runPullSync,
  type HttpFetch,
  type PullSource,
} from "../src/index";

const SOURCE: PullSource<{ api_key: string; streams?: Array<{ name: string }> }> = {
  source_id: "src_st",
  workspace_id: "ws_1",
  type: "stripe",
  name: "Stripe",
  config: {
    api_key: "sk_test_123",
    streams: [{ name: "customers" }],
  },
};

describe("Stripe pull connector", () => {
  it("builds incremental list URLs with created cursor and starting_after", () => {
    const url = buildStripeListUrl(
      SOURCE,
      "customers",
      { name: "customers", cursor_field: "created", sync_mode: "incremental" },
      { value: 100 },
      "cus_123",
    );
    expect(url).toBe("https://api.stripe.com/v1/customers?limit=100&created%5Bgt%5D=101&starting_after=cus_123");
  });

  it("emits records and uses Stripe pagination", async () => {
    const urls: string[] = [];
    const fetchImpl: HttpFetch = async (url) => {
      urls.push(url);
      if (!url.includes("starting_after=cus_1")) {
        return jsonResponse({ data: [{ id: "cus_1", created: 10 }], has_more: true });
      }
      return jsonResponse({ data: [{ id: "cus_2", created: 12 }], has_more: false });
    };
    const sink = new InMemoryPullRecordSink();
    const summary = await runPullSync(
      { source: SOURCE, connector: createStripeConnector(fetchImpl), stateStore: new InMemoryPullStateStore(), sink },
      { now: fixedNow },
    );
    expect(urls[1]).toContain("starting_after=cus_1");
    expect(sink.records.map((record) => record.record_id)).toEqual(["cus_1", "cus_2"]);
    expect(summary.streams[0]).toMatchObject({ records: 2, pages: 2, cursor: { value: 12 } });
  });

  it("resumes a crashed pageset from the page token instead of skipping older pages (descending stream)", async () => {
    // Stripe lists are newest-first. Page 1 = newest (created 1000); page 2 =
    // older (created 800). The first run delivers page 1, then crashes fetching
    // page 2. A naive per-page watermark checkpoint would commit cursor=1000, so
    // the resumed run's created[gt]=1001 would NEVER fetch the older page 2.
    const store = new InMemoryPullStateStore();

    const firstFetch: HttpFetch = async (url) => {
      if (!url.includes("starting_after=")) {
        return jsonResponse({ data: [{ id: "cus_new", created: 1000 }], has_more: true });
      }
      throw new Error("network crash mid-pageset");
    };
    const sink1 = new InMemoryPullRecordSink();
    const first = await runPullSync(
      { source: SOURCE, connector: createStripeConnector(firstFetch), stateStore: store, sink: sink1 },
      { now: fixedNow },
    );
    expect(first.streams[0]?.status).toBe("failed");
    expect(sink1.records.map((r) => r.record_id)).toEqual(["cus_new"]); // only page 1 delivered

    // Post-restart run reuses the persisted state. It must resume via
    // starting_after=cus_new (the saved page token), NOT jump created[gt] past
    // the older unread page.
    const urls: string[] = [];
    const secondFetch: HttpFetch = async (url) => {
      urls.push(url);
      return jsonResponse({ data: [{ id: "cus_old", created: 800 }], has_more: false });
    };
    const sink2 = new InMemoryPullRecordSink();
    const second = await runPullSync(
      { source: SOURCE, connector: createStripeConnector(secondFetch), stateStore: store, sink: sink2 },
      { now: fixedNow },
    );
    expect(urls[0]).toContain("starting_after=cus_new");
    expect(urls[0]).not.toContain("created%5Bgt%5D=1001"); // no gap jump
    expect(sink2.records.map((r) => r.record_id)).toEqual(["cus_old"]); // older page recovered
    expect(second.streams[0]).toMatchObject({ status: "success", cursor: { value: 1000 } });
  });

  it("carries the global high-watermark across three capped newest-first windows", async () => {
    const store = new InMemoryPullStateStore();
    await store.setStreamState(SOURCE.source_id, "customers", {
      cursor: { value: 500 },
      resumePageCursor: null,
      updated_at: fixedNow().toISOString(),
    });

    const urls: string[] = [];
    const connector = createStripeConnector(async (url) => {
      urls.push(url);
      if (url.includes("created%5Bgt%5D=1001")) {
        return jsonResponse({ data: [], has_more: false });
      }
      if (url.includes("starting_after=cus_new")) {
        return jsonResponse({ data: [{ id: "cus_mid", created: 800 }], has_more: true });
      }
      if (url.includes("starting_after=cus_mid")) {
        return jsonResponse({ data: [{ id: "cus_old", created: 600 }], has_more: false });
      }
      return jsonResponse({ data: [{ id: "cus_new", created: 1000 }], has_more: true });
    });

    const firstSink = new InMemoryPullRecordSink();
    const first = await runPullSync(
      {
        source: SOURCE,
        connector,
        stateStore: store,
        sink: firstSink,
      },
      { now: fixedNow, maxPagesPerStream: 1 },
    );

    expect(first.streams[0]).toMatchObject({
      status: "partial",
      cursor: { value: 500 },
      error: "max_pages_per_stream_reached",
    });
    expect(store.states.get(SOURCE.source_id)?.streams.customers).toMatchObject({
      cursor: { value: 500 },
      resumePageCursor: "cus_new",
      pendingHighWatermark: { value: 1000 },
    });

    const secondSink = new InMemoryPullRecordSink();
    const second = await runPullSync(
      {
        source: SOURCE,
        connector,
        stateStore: store,
        sink: secondSink,
      },
      { now: fixedNow, maxPagesPerStream: 1 },
    );
    expect(second.streams[0]?.status).toBe("partial");
    expect(secondSink.records.map((record) => record.record_id)).toEqual(["cus_mid"]);
    expect(store.states.get(SOURCE.source_id)?.streams.customers).toMatchObject({
      cursor: { value: 500 },
      resumePageCursor: "cus_mid",
      pendingHighWatermark: { value: 1000 },
    });

    const thirdSink = new InMemoryPullRecordSink();
    const third = await runPullSync(
      { source: SOURCE, connector, stateStore: store, sink: thirdSink },
      { now: fixedNow, maxPagesPerStream: 1 },
    );
    expect(thirdSink.records.map((record) => record.record_id)).toEqual(["cus_old"]);
    expect(third.streams[0]).toMatchObject({ status: "success", cursor: { value: 1000 } });
    expect(store.states.get(SOURCE.source_id)?.streams.customers).toMatchObject({
      cursor: { value: 1000 },
      resumePageCursor: null,
      pendingHighWatermark: null,
    });

    // A subsequent incremental sync starts beyond the pageset's true global
    // maximum and emits nothing; it must not replay the newer capped pages.
    const fourthSink = new InMemoryPullRecordSink();
    const fourth = await runPullSync(
      { source: SOURCE, connector, stateStore: store, sink: fourthSink },
      { now: fixedNow, maxPagesPerStream: 1 },
    );
    expect(fourth.streams[0]?.status).toBe("success");
    expect(fourthSink.records).toEqual([]);
    expect(urls[1]).toContain("starting_after=cus_new");
    expect(urls[1]).toContain("created%5Bgt%5D=501");
    expect(urls[2]).toContain("starting_after=cus_mid");
    expect(urls[3]).toContain("created%5Bgt%5D=1001");
  });
});

function jsonResponse(body: unknown) {
  return {
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  };
}

function fixedNow() {
  return new Date("2026-05-08T12:00:00.000Z");
}
