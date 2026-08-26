import { describe, expect, it } from "vitest";
import {
  createPostgresConnector,
  type PgClient,
  type PostgresConfig,
  type PullSource,
} from "../src/index";

const SOURCE: PullSource<PostgresConfig> = {
  source_id: "src_pg",
  workspace_id: "ws_1",
  type: "postgres",
  name: "Postgres",
  config: {
    connection_string: "postgres://u:p@db.example:5432/app",
    streams: [{ name: "users", table: "users", cursor_column: "id", cursor_type: "integer", sync_mode: "incremental" }],
  },
};

function fakeClient(): PgClient & { ended: number } {
  const client = {
    ended: 0,
    async query<T = Record<string, unknown>>() {
      return { rows: [] as T[] };
    },
    async end() {
      client.ended += 1;
    },
  };
  return client;
}

describe("postgres pull connector — close() ends the cached pool (connection-leak fix)", () => {
  it("ends the per-source client that read() cached", async () => {
    const client = fakeClient();
    let connectCalls = 0;
    const connector = createPostgresConnector({
      connect: async () => {
        connectCalls += 1;
        return client;
      },
    });
    const stream = connector.streams(SOURCE.config)[0]!;
    // First read() opens + caches the client.
    await stream.read({ source: SOURCE, stream: SOURCE.config.streams![0]!, state: null, now: () => new Date() });
    expect(connectCalls).toBe(1);
    expect(client.ended).toBe(0);

    // close() must end() the cached client so the worker/dashboard don't leak it.
    await connector.close?.();
    expect(client.ended).toBe(1);
  });

  it("exposes a close() method (was previously absent → silent no-op leak)", () => {
    const connector = createPostgresConnector({ connect: async () => fakeClient() });
    expect(typeof connector.close).toBe("function");
  });

  it("is a no-op (and swallows errors) when nothing was cached", async () => {
    const connector = createPostgresConnector({ connect: async () => fakeClient() });
    await expect(connector.close?.()).resolves.toBeUndefined();
  });
});

function recordingClient(pages: Array<Array<Record<string, unknown>>>): {
  client: PgClient & { ended: number };
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let i = 0;
  const client = {
    ended: 0,
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: (pages[i++] ?? []) as T[] };
    },
    async end() {
      client.ended += 1;
    },
  };
  return { client, calls };
}

describe("postgres pull connector — composite keyset (cursor-tie boundary)", () => {
  it("does not skip rows sharing the boundary cursor value across a page edge", async () => {
    // cursor_column `ts` has ties; `id` is the primary-key tiebreaker. page_size 3
    // forces a page boundary right in the middle of a run of ts=100 rows.
    const src: PullSource<PostgresConfig> = {
      ...SOURCE,
      config: {
        connection_string: SOURCE.config.connection_string,
        page_size: 3,
        streams: [{
          name: "events",
          table: "events",
          cursor_column: "ts",
          cursor_type: "integer",
          primary_key: "id",
          sync_mode: "incremental",
        }],
      },
    };
    const { client, calls } = recordingClient([
      // page 1 — a full page of ts=100 rows
      [{ id: 1, ts: 100 }, { id: 2, ts: 100 }, { id: 3, ts: 100 }],
      // page 2 — a 4th row ALSO at ts=100 (strict `>` on ts alone would skip it)
      [{ id: 4, ts: 100 }],
    ]);
    const connector = createPostgresConnector({ connect: async () => client });
    const reader = connector.streams(src.config)[0]!;
    const streamCfg = src.config.streams![0]!;

    const page1 = await reader.read({ source: src, stream: streamCfg, state: null, now: () => new Date() });
    expect(page1.records.map((r) => r.record_id)).toEqual(["1", "2", "3"]);
    // nextCursor carries the LAST row's (cursor, primary-key) keyset position.
    expect(JSON.parse(String(page1.nextCursor))).toEqual({ c: 100, pk: 3 });
    // first page: strict `>`/IS NULL, no tiebreak param. cursor=null, limit=3.
    expect(calls[0]?.params).toEqual([null, 3]);

    const page2 = await reader.read({
      source: src,
      stream: streamCfg,
      state: null,
      pageCursor: page1.nextCursor,
      now: () => new Date(),
    });
    // The boundary row a strict `>` would have dropped is delivered.
    expect(page2.records.map((r) => r.record_id)).toEqual(["4"]);
    expect(page2.nextCursor).toBeUndefined(); // short page → done

    // page 2 used the composite keyset (= $1 AND pk > $2), with [cursor, lastPk, limit].
    expect(calls[1]?.sql).toMatch(/= \$1 AND .*> \$2/);
    expect(calls[1]?.params).toEqual([100, 3, 3]);
  });
});
