import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueMessage } from "@axel/shared";
import { logEventToClickhouse } from "../src/clickhouse-log.js";

describe("ingest ClickHouse metadata boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops arbitrary header and query values even from a legacy caller", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 200 }),
    );
    const message: QueueMessage = {
      event_id: "evt_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      r2_key: "events/ws_1/2026-08-27/evt_1",
      received_at: "2026-08-27T12:00:00.000Z",
      content_type: "application/json",
      size_bytes: 12,
      shard: 1,
      headers: {
        "x-customer-ref": "secret-under-innocuous-header-name",
        "x-api-token": "obvious-secret",
      },
      query: { campaign: "secret-under-innocuous-query-name" },
      is_test: false,
    };

    await logEventToClickhouse({ CLICKHOUSE_URL: "https://clickhouse.example" }, message);

    const [, init] = fetchSpy.mock.calls[0]!;
    const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(row.headers_json).toBe("{}");
    expect(row.query_json).toBe("{}");
    expect(String(init?.body)).not.toContain("secret-under-innocuous");
    expect(String(init?.body)).not.toContain("obvious-secret");
  });
});
