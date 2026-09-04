import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAttemptId, logDeliveryAttempt } from "../src/clickhouse-log.ts";

describe("delivery-service ClickHouse attempt logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does nothing when ClickHouse is not configured", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await logDeliveryAttempt({}, attempt());

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes a delivery_attempts JSONEachRow row", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    await logDeliveryAttempt(
      {
        CLICKHOUSE_URL: "https://clickhouse.example",
        CLICKHOUSE_USER: "default",
        CLICKHOUSE_PASSWORD: "secret",
      },
      attempt(),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("INSERT+INTO+delivery_attempts+FORMAT+JSONEachRow");
    expect(String(url)).toContain("async_insert=1");
    expect(String(url)).toContain("wait_for_async_insert=0");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "content-type": "application/x-ndjson",
      "x-clickhouse-user": "default",
      "x-clickhouse-key": "secret",
    });
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspace_id: "ws-1",
      event_id: "evt-1",
      route_id: "rt-1",
      destination_id: "dest-1",
      attempt_id: "evt-1-dest-1-2",
      attempt_no: 2,
      status: "success",
      is_test: false,
      response_json: "{\"destination_type\":\"mongodb\"}",
      created_at: "2026-05-02 12:00:02.000",
    });
  });

  it("writes is_test=true for test-event deliveries so billing excludes them", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    await logDeliveryAttempt(
      { CLICKHOUSE_URL: "https://clickhouse.example" },
      { ...attempt(), is_test: true },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ is_test: true });
  });

  it("drops downstream bodies and collapses diagnostics before persistence", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    await logDeliveryAttempt(
      { CLICKHOUSE_URL: "https://clickhouse.example" },
      {
        ...attempt(),
        response: {
          status: 400,
          body: '{"password":"raw-webhook-secret"}',
          error: 'invalid value "alice@example.test" from customer_schema_marker',
          table: "customer_table_marker",
        },
      },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    const row = JSON.parse(String(init?.body)) as { response_json: string };
    expect(row.response_json).not.toContain("raw-webhook-secret");
    expect(row.response_json).not.toContain("alice@example.test");
    expect(row.response_json).not.toContain("customer_schema_marker");
    expect(row.response_json).not.toContain("customer_table_marker");
    expect(JSON.parse(row.response_json)).toEqual({
      http_status: 400,
      error: "delivery_failed",
    });
  });

  it("uses deterministic attempt ids", () => {
    expect(buildAttemptId({ event_id: "evt-1", destination_id: "dest-1", attempt_no: 3 })).toBe(
      "evt-1-dest-1-3",
    );
  });
});

function attempt() {
  return {
    workspace_id: "ws-1",
    event_id: "evt-1",
    route_id: "rt-1",
    destination_id: "dest-1",
    attempt_id: "evt-1-dest-1-2",
    attempt_no: 2,
    status: "success" as const,
    latency_ms: 12,
    is_test: false,
    response: { destination_type: "mongodb" },
    created_at: "2026-05-02T12:00:02.000Z",
  };
}
