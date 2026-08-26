import { describe, expect, it, vi } from "vitest";
import {
  createMongodbConnector,
  InMemoryPullRecordSink,
  InMemoryPullStateStore,
  runPullSync,
  type PullSource,
} from "../src/index";

// Minimal chainable stub for collection.find(...).sort(...).limit(...).toArray().
function fakeCollection(rows: unknown[]) {
  const chain = {
    find: () => chain,
    sort: () => chain,
    limit: () => chain,
    toArray: async () => rows,
    aggregate: () => chain,
  };
  return chain;
}

const SOURCE: PullSource<{
  database: string;
  streams: Array<{ name: string; collection: string; cursor_column: string; cursor_type?: string }>;
}> = {
  source_id: "src_mongo",
  workspace_id: "ws_1",
  type: "mongodb",
  name: "Mongo",
  config: {
    database: "app",
    streams: [{ name: "events", collection: "events", cursor_column: "_id", cursor_type: "objectid" }],
  },
};

// Records every find(...) filter so we can assert the cursor predicate actually
// paginated PAST page 1 (used the input.pageCursor, not the static base cursor).
function recordingCollection(rows: unknown[]) {
  const filters: Array<Record<string, unknown>> = [];
  const chain = {
    find: (filter: Record<string, unknown>) => {
      filters.push(filter);
      return chain;
    },
    sort: () => chain,
    limit: () => chain,
    toArray: async () => rows,
    aggregate: () => chain,
  };
  return { chain, filters };
}

function mongoStream(rows: unknown[], pageSize: number) {
  const { chain, filters } = recordingCollection(rows);
  const connector = createMongodbConnector({
    connect: async () => ({ db: () => ({ collection: () => chain }), close: async () => {} }),
  });
  const source: PullSource<{
    database: string;
    page_size: number;
    streams: Array<{ name: string; collection: string; cursor_column: string; cursor_type?: string }>;
  }> = {
    source_id: "src_mongo",
    workspace_id: "ws_1",
    type: "mongodb",
    name: "Mongo",
    config: {
      database: "app",
      page_size: pageSize,
      streams: [{ name: "events", collection: "events", cursor_column: "seq", cursor_type: "integer" }],
    },
  };
  const stream = connector.streams(source.config)[0]!;
  const streamConfig = source.config.streams[0]!;
  return { stream, streamConfig, source, filters };
}

describe("mongodb pull connector — pagination (read past page 1)", () => {
  it("returns a defined nextCursor when the page is full (records.length === pageSize)", async () => {
    const pageSize = 2;
    const { stream, streamConfig, source } = mongoStream(
      [{ _id: "a", seq: 1 }, { _id: "b", seq: 2 }], // exactly pageSize rows → more may follow
      pageSize,
    );
    const page = await stream.read({
      source,
      stream: streamConfig,
      state: null,
      now: () => new Date("2026-06-23T00:00:00Z"),
    });
    expect(page.records).toHaveLength(2);
    // Regression: a full page MUST hand the runner a nextCursor so it fetches the
    // next page this tick — otherwise any collection larger than page_size was
    // silently truncated to its first page.
    expect(page.nextCursor).toBeDefined();
    expect(page.nextCursor).toBe("2"); // the page's high-watermark cursor value
  });

  it("returns an undefined nextCursor when the page is short (fewer than pageSize)", async () => {
    const pageSize = 5;
    const { stream, streamConfig, source } = mongoStream(
      [{ _id: "a", seq: 1 }, { _id: "b", seq: 2 }], // short page → stream drained
      pageSize,
    );
    const page = await stream.read({
      source,
      stream: streamConfig,
      state: null,
      now: () => new Date("2026-06-23T00:00:00Z"),
    });
    expect(page.records).toHaveLength(2);
    expect(page.nextCursor).toBeUndefined();
  });

  it("uses input.pageCursor (paginates past page 1) rather than the base state cursor", async () => {
    const pageSize = 2;
    const { stream, streamConfig, source, filters } = mongoStream(
      [{ _id: "c", seq: 3 }, { _id: "d", seq: 4 }],
      pageSize,
    );
    // The committed base cursor is 1, but the runner re-calls read() with the
    // prior page's nextCursor ("2"). The query must filter on the page cursor, not
    // the base — otherwise it re-reads page 1 forever.
    await stream.read({
      source,
      stream: streamConfig,
      state: { cursor: { value: 1 }, updated_at: "2026-06-22T00:00:00Z" },
      pageCursor: "2",
      now: () => new Date("2026-06-23T00:00:00Z"),
    });
    expect(filters).toHaveLength(1);
    // The runner's page token ("2") is used verbatim as the $gt bound — proving
    // pagination advanced past the base cursor (1) rather than re-reading page 1.
    expect(filters[0]).toEqual({ seq: { $gt: "2" } });
  });
});

describe("mongodb pull connector — client lifecycle", () => {
  it("caches one client per run and closes it on connector.close() (no per-tick leak)", async () => {
    const close = vi.fn(async () => {});
    let connects = 0;
    const connector = createMongodbConnector({
      connect: async () => {
        connects += 1;
        return { db: () => ({ collection: () => fakeCollection([]) }), close };
      },
    });

    await runPullSync(
      { source: SOURCE, connector, stateStore: new InMemoryPullStateStore(), sink: new InMemoryPullRecordSink() },
      {},
    );
    expect(connects).toBe(1); // one cached client for the whole run
    expect(close).not.toHaveBeenCalled(); // never closed mid-run

    // The pull-worker calls this in a finally after every sync run — without it
    // the per-tick registry rebuild leaked the MongoClient (and its pool).
    await connector.close?.();
    expect(close).toHaveBeenCalledOnce();
  });
});
