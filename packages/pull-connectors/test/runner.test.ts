import { describe, expect, it } from "vitest";
import {
  InMemoryPullRecordSink,
  InMemoryPullStateStore,
  runPullSync,
  sanitizePullRunSummaryForStorage,
  type PullConnector,
  type PullPage,
  type PullRecord,
  type PullSource,
} from "../src/index";

const SOURCE: PullSource<{ streams: Array<{ name: string }> }> = {
  source_id: "src_cap",
  workspace_id: "ws_1",
  type: "stripe",
  name: "Cap test",
  config: { streams: [{ name: "records" }] },
};

describe("pull runner safety caps", () => {
  it("pauses at the record cap on a page boundary and retains the continuation", async () => {
    const store = new InMemoryPullStateStore();
    const sink = new InMemoryPullRecordSink();
    const seenPageCursors: Array<string | undefined> = [];
    const connector = pagedConnector((pageCursor) => {
      seenPageCursors.push(pageCursor);
      return pageCursor === "page-2"
        ? page([record("r3", 3)], null)
        : page([record("r1", 1), record("r2", 2)], "page-2");
    });

    const first = await runPullSync(
      { source: SOURCE, connector, stateStore: store, sink },
      { now: fixedNow, maxRecordsPerStream: 1 },
    );

    // The cap is deliberately page-boundary based: both records from the page
    // are emitted so its opaque continuation can advance without data loss.
    expect(sink.records.map((item) => item.record_id)).toEqual(["r1", "r2"]);
    expect(first.streams[0]).toMatchObject({
      status: "partial",
      records: 2,
      cursor: null,
      error: "max_records_per_stream_reached",
    });
    expect(store.states.get(SOURCE.source_id)?.streams.records).toMatchObject({
      cursor: null,
      resumePageCursor: "page-2",
      pendingHighWatermark: { value: 2 },
    });

    const secondSink = new InMemoryPullRecordSink();
    const second = await runPullSync(
      { source: SOURCE, connector, stateStore: store, sink: secondSink },
      { now: fixedNow, maxRecordsPerStream: 1 },
    );

    expect(seenPageCursors).toEqual([undefined, "page-2"]);
    expect(secondSink.records.map((item) => item.record_id)).toEqual(["r3"]);
    expect(second.streams[0]).toMatchObject({ status: "success", cursor: { value: 3 } });
    expect(store.states.get(SOURCE.source_id)?.streams.records?.resumePageCursor).toBeNull();
    expect(store.states.get(SOURCE.source_id)?.streams.records?.pendingHighWatermark).toBeNull();
  });

  it("reports success when the final page lands exactly on the record cap", async () => {
    const store = new InMemoryPullStateStore();
    const sink = new InMemoryPullRecordSink();
    const result = await runPullSync(
      {
        source: SOURCE,
        connector: pagedConnector(() => page([record("r1", 1)], null)),
        stateStore: store,
        sink,
      },
      { now: fixedNow, maxRecordsPerStream: 1 },
    );

    expect(result.streams[0]).toMatchObject({ status: "success", records: 1, cursor: { value: 1 } });
  });

  it("sanitizes connector errors before returning a diagnostic summary", async () => {
    const result = await runPullSync({
      source: SOURCE,
      connector: pagedConnector(() => {
        throw new Error(
          'HTTP 502: payload={"email":"victim@example.com","api_key":"sk_live_response_secret"}',
        );
      }),
      stateStore: new InMemoryPullStateStore(),
      sink: new InMemoryPullRecordSink(),
    });

    expect(result.streams[0]).toMatchObject({
      status: "failed",
      error: "http_error_502",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("sk_live_response_secret");
    expect(serialized).not.toContain("HTTP 502");
  });

  it("omits customer cursor values from the persistence-safe summary", () => {
    const stored = sanitizePullRunSummaryForStorage({
      source_id: SOURCE.source_id,
      source_type: SOURCE.type,
      started_at: fixedNow().toISOString(),
      finished_at: fixedNow().toISOString(),
      streams: [{
        stream: "customer_stream_private",
        records: 1,
        pages: 1,
        cursor: { value: "victim@example.com" },
        status: "failed",
        error: "HTTP 400: password=hunter2",
      }],
    });
    const serialized = JSON.stringify(stored);

    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("hunter2");
    expect(stored).toMatchObject({
      streams: [{
        stream: "pull_stream",
        cursor_present: true,
        error: "http_error_400",
      }],
    });
    expect(serialized).not.toContain("customer_stream_private");
    expect(serialized).not.toContain("HTTP 400");
  });
});

function pagedConnector(readPage: (pageCursor: string | undefined) => PullPage): PullConnector<{ streams: Array<{ name: string }> }> {
  return {
    type: "stripe",
    streams: () => [{
      name: "records",
      defaultCursorField: "created",
      read: async (input) => readPage(input.pageCursor),
    }],
  };
}

function page(records: PullRecord[], nextCursor: string | null): PullPage {
  const result: PullPage = {
    records,
    highWatermark: records.at(-1)?.cursor ?? null,
  };
  if (nextCursor) result.nextCursor = nextCursor;
  return result;
}

function record(id: string, cursor: number): PullRecord {
  return {
    source_id: SOURCE.source_id,
    workspace_id: SOURCE.workspace_id,
    source_type: SOURCE.type,
    stream: "records",
    record_id: id,
    cursor: { value: cursor },
    extracted_at: fixedNow().toISOString(),
    data: { id, created: cursor },
  };
}

function fixedNow() {
  return new Date("2026-07-09T12:00:00.000Z");
}
