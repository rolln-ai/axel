import { afterEach, describe, expect, it, vi } from "vitest";
import { AxelPipelinePullRecordSink, type IngestQueueSink, type RawPayloadStore } from "../src/index.js";

describe("pull worker ClickHouse event logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes pull-emitted records to R2, queue, and ClickHouse events", async () => {
    const rawWrites: Array<{ key: string; metadata: Record<string, string> }> = [];
    const queueMessages: unknown[] = [];
    const rawPayloads: RawPayloadStore = {
      async put(key, _body, metadata) {
        rawWrites.push({ key, metadata });
      },
    };
    const ingestQueue: IngestQueueSink = {
      async enqueue(message) {
        queueMessages.push(message);
      },
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => "",
    } as Response);

    const sink = new AxelPipelinePullRecordSink({
      rawPayloads,
      ingestQueue,
      clickhouse: {
        CLICKHOUSE_URL: "https://clickhouse.example",
        CLICKHOUSE_USER: "default",
        CLICKHOUSE_PASSWORD: "secret",
      },
      now: () => new Date("2026-05-08T12:00:00.000Z"),
    });

    await sink.write({
      source_id: "src_cb",
      workspace_id: "ws_1",
      source_type: "chargebee",
      stream: "customers",
      record_id: "cus_1",
      cursor: { value: 123 },
      extracted_at: "2026-05-08T12:00:00.000Z",
      data: { id: "cus_1", updated_at: 123 },
    });

    expect(rawWrites[0]?.key).toBe("pull/ws_1/src_cb/customers/pull_chargebee_customers_cus_1_123.json");
    expect(queueMessages).toHaveLength(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain("INSERT+INTO+events+FORMAT+JSONEachRow");
    expect(String(url)).toContain("async_insert=1");
    expect(String(url)).toContain("wait_for_async_insert=0");
    expect(init?.headers).toMatchObject({
      "content-type": "application/x-ndjson",
      "x-clickhouse-user": "default",
      "x-clickhouse-key": "secret",
    });

    const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(row).toMatchObject({
      workspace_id: "ws_1",
      source_id: "src_cb",
      event_id: "pull_chargebee_customers_cus_1_123",
      r2_key: "pull/ws_1/src_cb/customers/pull_chargebee_customers_cus_1_123.json",
      received_at: "2026-05-08 12:00:00.000",
      content_type: "application/json",
      size_bytes: expect.any(Number),
      headers_json: JSON.stringify({
        "x-axel-pull-source-type": "chargebee",
        "x-axel-pull-stream": "customers",
      }),
      query_json: "{}",
    });
  });
});
