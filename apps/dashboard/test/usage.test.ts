import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deliveryRates,
  densifyDailySeries,
  formatBytes,
  formatCount,
  getDailyDeliveryStats,
  getDailyUsage,
  getEventDetail,
  getSourceDailyUsage,
  getWorkspaceUsage,
  listRecentRouteEvents,
  listWorkspaceDeliveryAttempts,
  listWorkspaceEventFacets,
  listWorkspaceEvents,
  listWorkspaceFailureTypes,
  listSourceUsage,
} from "../lib/usage";
import { clickhouse } from "../lib/clickhouse";
import {
  BASE_EVENT_ID_EXPR,
  SUCCESS_PREDICATE,
  TERMINAL_FAILURE_PREDICATE,
  latestOutcomesCTE,
} from "../lib/clickhouse-fragments";
import { fakeClickhouse } from "@axel/test-utils";

const NOW = new Date("2026-05-15T12:00:00Z");

describe("usage", () => {
  afterEach(() => {
    vi.useRealTimers();
    delete globalThis.__axelClickhouseFetch;
    delete process.env.CLICKHOUSE_URL;
    delete process.env.CLICKHOUSE_QUERY_TIMEOUT_MS;
    delete process.env.CLICKHOUSE_QUERY_MAX_MEMORY_BYTES;
    delete process.env.CLICKHOUSE_QUERY_MAX_THREADS;
    delete process.env.CLICKHOUSE_QUERY_MAX_RESULT_ROWS;
  });

  it("accepts empty successful ClickHouse mutation responses", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    globalThis.__axelClickhouseFetch = vi.fn(async () => new Response("", { status: 200 }));

    await expect(clickhouse().query("ALTER TABLE events DELETE WHERE workspace_id = {workspace_id:String}", {
      workspace_id: "ws_test",
    })).resolves.toEqual({ rows: [] });
  });

  it("retries transient ClickHouse 5xx responses", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    globalThis.__axelClickhouseFetch = vi.fn()
      .mockResolvedValueOnce(new Response("<!DOCTYPE html>", { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ n: "1" }] }), { status: 200 }));

    await expect(clickhouse().query<{ n: string }>("SELECT 1")).resolves.toEqual({
      rows: [{ n: "1" }],
    });
    expect(globalThis.__axelClickhouseFetch).toHaveBeenCalledTimes(2);
  });

  it("does not expose ClickHouse response bodies in errors", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    globalThis.__axelClickhouseFetch = vi.fn(async () => (
      new Response("provider-private-response", { status: 400 })
    ));

    const query = clickhouse().query("SELECT 1");
    await expect(query).rejects.toThrow(/^ClickHouse query failed \(400\)$/);
    await expect(query).rejects.not.toThrow(/provider-private-response/);
  });

  it("lets background callers override and retry the interactive query timeout", async () => {
    vi.useFakeTimers();
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    globalThis.__axelClickhouseFetch = vi.fn()
      .mockImplementationOnce((_input: string | URL | Request, init?: RequestInit) => (
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ n: "1" }] }), { status: 200 }));

    const query = clickhouse({ timeoutMs: 30_000, retryTimeouts: true })
      .query<{ n: string }>("SELECT 1");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(250);

    await expect(query).resolves.toEqual({ rows: [{ n: "1" }] });
    expect(globalThis.__axelClickhouseFetch).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(String(vi.mocked(globalThis.__axelClickhouseFetch).mock.calls[0]?.[0]));
    expect(firstUrl.searchParams.get("max_execution_time")).toBe("30");
  });

  it("sends bounded memory settings with ClickHouse queries", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    process.env.CLICKHOUSE_QUERY_MAX_MEMORY_BYTES = "123456";
    process.env.CLICKHOUSE_QUERY_MAX_THREADS = "1";
    process.env.CLICKHOUSE_QUERY_MAX_RESULT_ROWS = "25";
    globalThis.__axelClickhouseFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await clickhouse().query("SELECT 1");

    const url = new URL(String(vi.mocked(globalThis.__axelClickhouseFetch).mock.calls[0]?.[0]));
    expect(url.searchParams.get("max_memory_usage")).toBe("123456");
    expect(url.searchParams.get("max_bytes_before_external_group_by")).toBe("30864");
    expect(url.searchParams.get("max_bytes_before_external_sort")).toBe("30864");
    expect(url.searchParams.get("max_threads")).toBe("1");
    expect(url.searchParams.get("max_result_rows")).toBe("25");
    expect(url.searchParams.get("result_overflow_mode")).toBe("break");
  });

  it("omits the result-row cap when unbounded so billing/metering aggregates aren't silently truncated", async () => {
    process.env.CLICKHOUSE_URL = "https://clickhouse.example";
    process.env.CLICKHOUSE_QUERY_MAX_RESULT_ROWS = "25";
    globalThis.__axelClickhouseFetch = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await clickhouse({ unbounded: true }).query("SELECT workspace_id, count() FROM events GROUP BY workspace_id");

    const url = new URL(String(vi.mocked(globalThis.__axelClickhouseFetch).mock.calls[0]?.[0]));
    // The billing rollup GROUP BYs every active workspace; result_overflow_mode=break
    // would silently drop workspaces past the cap → never metered, billed, or capped.
    expect(url.searchParams.has("max_result_rows")).toBe(false);
    expect(url.searchParams.has("result_overflow_mode")).toBe(false);
    // The unrelated safety settings are still applied.
    expect(url.searchParams.get("default_format")).toBe("JSON");
    delete process.env.CLICKHOUSE_QUERY_MAX_RESULT_ROWS;
  });

  it("formatCount adds thousands separators", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(5_000_000)).toBe("5,000,000");
  });

  it("formatBytes scales to human-readable units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1500)).toBe("1.50 KB");
    expect(formatBytes(2_500_000_000)).toBe("2.50 GB");
  });

  it("deliveryRates returns zeros when no attempts", () => {
    const rates = deliveryRates({
      windowStart: "2026-05-01T00:00:00.000Z",
      windowEnd: "2026-06-01T00:00:00.000Z",
      eventsThisMonth: 0,
      eventsPreviousMonth: 0,
      eventsLast24h: 0,
      bytesThisMonth: 0,
      deliveryAttemptsThisMonth: 0,
      deliveriesSucceededThisMonth: 0,
      retriesThisMonth: 0,
      deadDeliveriesThisMonth: 0,
    });
    expect(rates).toEqual({ success: 0, failure: 0, retry: 0, dead: 0 });
  });

  it("deliveryRates computes success/retry/dead percentages", () => {
    const rates = deliveryRates({
      windowStart: "2026-05-01T00:00:00.000Z",
      windowEnd: "2026-06-01T00:00:00.000Z",
      eventsThisMonth: 1000,
      eventsPreviousMonth: 800,
      eventsLast24h: 50,
      bytesThisMonth: 5_000_000,
      deliveryAttemptsThisMonth: 1100,
      deliveriesSucceededThisMonth: 1000,
      retriesThisMonth: 80,
      deadDeliveriesThisMonth: 20,
    });
    expect(rates.success).toBeCloseTo(0.909, 3);
    expect(rates.failure).toBeCloseTo(0.0909, 3);
    expect(rates.retry).toBeCloseTo(0.0727, 3);
    expect(rates.dead).toBeCloseTo(0.01818, 3);
  });

  it("listWorkspaceFailureTypes groups failed attempts by human-readable error type", async () => {
    const { client } = fakeClickhouse({
      responses: [
        [
          { response_json: JSON.stringify({ error: "already_delivered" }), status: "dead", c: "3" },
          { response_json: JSON.stringify({ error: "already-delivered" }), status: "retry", c: "2" },
          { response_json: JSON.stringify({ http_status: 503 }), status: "retry", c: "4" },
          {
            response_json: JSON.stringify({
              error: "SELECT failed on marker_schema: marker-secret provider body",
            }),
            status: "dead",
            c: "1",
          },
        ],
      ],
    });

    const rows = await listWorkspaceFailureTypes("ws_test", {
      clickhouse: client,
      now: () => NOW,
    });

    expect(rows).toEqual([
      { error_type: "HTTP 503", count: 4 },
      { error_type: "delivery failed", count: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toContain("marker_schema");
    expect(JSON.stringify(rows)).not.toContain("marker-secret");
  });

  it("listWorkspaceFailureTypes queries the normalized latest-outcome rollup", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[]] });

    await listWorkspaceFailureTypes("ws_test", { clickhouse: client, now: () => NOW });

    expect(calls[0]?.sql).toContain("FROM delivery_base_latest_outcomes");
    expect(calls[0]?.sql).not.toContain("FINAL");
    expect(calls[0]?.sql).toContain("argMax(latest_status, latest_at)");
    expect(calls[0]?.sql).toContain(`NOT ${SUCCESS_PREDICATE}`);
    expect(calls[0]?.sql).toContain("already_delivered");
    expect(calls[0]?.sql).toContain("GROUP BY outcome_response, outcome_status");
  });

  it("listWorkspaceFailureTypes falls back to raw attempts before rollups are installed", async () => {
    const { client, calls } = fakeClickhouse({ responses: [new Error("UNKNOWN_TABLE"), []] as never });

    await listWorkspaceFailureTypes("ws_test", { clickhouse: client, now: () => NOW });

    expect(calls[0]?.sql).toContain("FROM delivery_base_latest_outcomes");
    expect(calls[1]?.sql).toContain(latestOutcomesCTE({ source: "attempts" }));
    expect(calls[1]?.sql).toContain("GROUP BY base_event_id, route_id, destination_id");
    expect(calls[1]?.sql).toContain("replaceRegexpOne(event_id, '#rpy_[A-Za-z0-9_-]+$', '')");
  });

  it("getWorkspaceUsage assembles month summary from ClickHouse rows", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [{ events: "5000000", bytes: "12500000000" }], // current month events
        [{ c: "4200000" }], // previous month events
        [{ c: "168000" }], // last 24h
        [{ attempts: "5250000", success: "5100000", retries: "120000", dead: "30000" }],
      ],
    });

    const summary = await getWorkspaceUsage("ws_test", { clickhouse: client, now: () => NOW });

    expect(summary.eventsThisMonth).toBe(5_000_000);
    expect(summary.eventsPreviousMonth).toBe(4_200_000);
    expect(summary.eventsLast24h).toBe(168_000);
    expect(summary.bytesThisMonth).toBe(12_500_000_000);
    expect(summary.deliveryAttemptsThisMonth).toBe(5_250_000);
    expect(summary.deliveriesSucceededThisMonth).toBe(5_100_000);
    expect(summary.retriesThisMonth).toBe(120_000);
    expect(summary.deadDeliveriesThisMonth).toBe(30_000);
    expect(summary.windowStart).toBe("2026-05-01T00:00:00.000Z");
    expect(summary.windowEnd).toBe("2026-06-01T00:00:00.000Z");

    // Each ClickHouse query gets the workspace_id parameter, never inlined.
    for (const call of calls) {
      expect(call.params.workspace_id).toBe("ws_test");
      expect(call.sql).not.toContain("ws_test");
    }
    expect(calls[0]?.sql).toContain("FROM events_daily");
    expect(calls[3]?.sql).toContain("FROM delivery_base_latest_outcomes");
    expect(calls[3]?.sql).not.toContain("FINAL");
    expect(calls[3]?.sql).toContain("argMax(latest_status, latest_at)");
    expect(calls[3]?.sql).toContain("already_delivered");
  });

  it("listSourceUsage returns top sources with numeric coercion", async () => {
    const { client } = fakeClickhouse({
      responses: [
        [
          { source_id: "src_stripe", events: "3000000", bytes: "9000000000" },
          { source_id: "src_segment", events: "1500000", bytes: "3000000000" },
          { source_id: "src_github", events: 500_000, bytes: 800_000_000 },
        ],
      ],
    });

    const rows = await listSourceUsage("ws_test", { clickhouse: client, now: () => NOW });
    expect(rows).toEqual([
      { source_id: "src_stripe", events: 3_000_000, bytes: 9_000_000_000 },
      { source_id: "src_segment", events: 1_500_000, bytes: 3_000_000_000 },
      { source_id: "src_github", events: 500_000, bytes: 800_000_000 },
    ]);
  });

  it("getDailyUsage reads the events_daily rollup over the rolling window", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          { day: "2026-05-13", events: "100000", bytes: "200000000" },
          { day: "2026-05-14", events: "120000", bytes: "240000000" },
          { day: "2026-05-15", events: "80000", bytes: "160000000" },
        ],
      ],
    });

    const rows = await getDailyUsage("ws_test", 30, { clickhouse: client, now: () => NOW });
    expect(rows.map((r) => r.day)).toEqual(["2026-05-13", "2026-05-14", "2026-05-15"]);
    expect(rows[1]?.events).toBe(120_000);
    const expectedStart = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(calls[0]?.params.start).toBe(expectedStart);
    expect(calls[0]?.sql).toContain("FROM events_daily");
    expect(calls[0]?.sql).toContain("uniqExactMerge(events)");
  });

  it("getDailyUsage falls back to raw events when the rollup is missing, applying workspace timezone", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        new Error("Code: 60. DB::Exception: Table default.events_daily does not exist"),
        [{ day: "2026-05-15", events: "5", bytes: "1234" }],
      ],
    });

    const rows = await getDailyUsage("ws_test", 30, {
      clickhouse: client,
      now: () => NOW,
      timezone: "America/Denver",
    });

    expect(rows).toEqual([{ day: "2026-05-15", events: 5, bytes: 1234 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.sql).toContain("FROM events_daily");
    expect(calls[1]?.sql).toContain("FROM events");
    expect(calls[1]?.sql).toContain("toDate(received_at, {timezone:String})");
    expect(calls[1]?.params.timezone).toBe("America/Denver");
  });

  it("getSourceDailyUsage scopes the rollup query to one source", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          { day: "2026-05-14", events: "12", bytes: "2400" },
          { day: "2026-05-15", events: 8, bytes: 1600 },
        ],
      ],
    });

    const rows = await getSourceDailyUsage("ws_test", "src_test", 14, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(rows).toEqual([
      { day: "2026-05-14", events: 12, bytes: 2400 },
      { day: "2026-05-15", events: 8, bytes: 1600 },
    ]);
    expect(calls[0]?.params.workspace_id).toBe("ws_test");
    expect(calls[0]?.params.source_id).toBe("src_test");
    expect(calls[0]?.sql).toContain("FROM events_daily");
    expect(calls[0]?.sql).toContain("source_id = {source_id:String}");
  });

  it("getDailyDeliveryStats counts latest outcomes rather than retry attempts", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          { day: "2026-05-15", success: "10", retry: "1", dead: "2" },
        ],
      ],
    });

    const rows = await getDailyDeliveryStats("ws_test", 14, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(rows).toEqual([{ day: "2026-05-15", success: 10, retry: 1, dead: 2 }]);
    expect(calls[0]?.sql).toContain("FROM delivery_base_latest_outcomes");
    expect(calls[0]?.sql).not.toContain("FINAL");
    expect(calls[0]?.sql).toContain("argMax(latest_status, latest_at)");
    expect(calls[0]?.sql).toContain("toDate(outcome_at, {timezone:String})");
    expect(calls[0]?.sql).toContain("already_delivered");
    expect(calls[0]?.sql).toContain("AS success");
    expect(calls[0]?.sql).toContain("GROUP BY day");
  });

  it("densifyDailySeries uses the workspace-local current day", () => {
    const now = new Date("2026-05-08T02:30:00.000Z");

    const rows = densifyDailySeries(
      [{ day: "2026-05-07", events: 5, bytes: 100 }],
      2,
      (day) => ({ day, events: 0, bytes: 0 }),
      "America/Denver",
      now,
    );

    expect(rows.map((row) => row.day)).toEqual(["2026-05-06", "2026-05-07"]);
    expect(rows[1]?.events).toBe(5);
  });

  it("listWorkspaceDeliveryAttempts can filter by status", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          {
            attempt_id: "att_1",
            event_id: "evt_1",
            source_id: "src_1",
            route_id: "rte_1",
            destination_id: "dst_1",
            attempt_no: "2",
            status: "dead",
            latency_ms: "1500",
            response_json: JSON.stringify({ http_status: 500, error: "upstream failed" }),
            created_at: "2026-05-15 12:00:00.000",
          },
        ],
      ],
    });

    const rows = await listWorkspaceDeliveryAttempts("ws_test", "dead", 25, { clickhouse: client });

    expect(rows[0]).toMatchObject({
      attempt_id: "att_1",
      event_id: "evt_1",
      source_id: "src_1",
      status: "dead",
      attempt_no: 2,
      latency_ms: 1500,
      response: { http_status: 500, error: "delivery_failed" },
    });
    expect(calls[0]?.params).toMatchObject({ workspace_id: "ws_test", status: "dead", limit: 25 });
    expect(calls[0]?.sql).toContain("d.status = {status:String}");
  });

  it("returns only bounded delivery response fields and stable error codes", async () => {
    const marker = "postgresql://user:marker-secret@private-db.internal/marker_schema";
    const { client } = fakeClickhouse({
      responses: [
        [
          {
            attempt_id: "att_private",
            event_id: "evt_private",
            source_id: "src_private",
            route_id: "rte_private",
            destination_id: "dst_private",
            attempt_no: "1",
            status: "dead",
            latency_ms: "20",
            response_json: JSON.stringify({
              destination_type: "webhook",
              http_status: 502,
              error: marker,
              customer_id: "cus_marker_private",
              customer_email: "customer@example.com",
              endpoint_url: "https://customer.example/hook?token=private",
              stream: "customer_stream_private",
              destination_id: "customer_destination_private",
              component: "customer_component_private",
              exception: "raw provider exception for customer@example.com",
              provider_request_id: "provider-marker-id",
              response_body: "marker webhook payload",
            }),
            created_at: "2026-05-15 12:00:00.000",
          },
        ],
      ],
    });

    const rows = await listWorkspaceDeliveryAttempts("ws_test", "dead", 25, {
      clickhouse: client,
    });

    expect(rows[0]?.response).toEqual({
      destination_type: "webhook",
      http_status: 502,
      error: "delivery_failed",
    });
    expect(JSON.stringify(rows[0]?.response)).not.toContain(marker);
    expect(JSON.stringify(rows[0]?.response)).not.toContain("cus_marker_private");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("customer@example.com");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("customer.example");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("customer_stream_private");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("customer_destination_private");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("customer_component_private");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("raw provider exception");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("provider-marker-id");
    expect(JSON.stringify(rows[0]?.response)).not.toContain("marker webhook payload");
  });

  it("listRecentRouteEvents limits the route scan to the last 24 hours before grouping", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          {
            event_id: "evt_1",
            source_id: "src_1",
            received_at: "2026-05-15 11:55:00.000",
            size_bytes: "2048",
            statuses_pack: "dst_pg:success,dst_s3:retry",
            last_attempt_at: "2026-05-15 12:00:00.000",
          },
        ],
      ],
    });

    const rows = await listRecentRouteEvents("ws_test", "rt_test", 30, {
      clickhouse: client,
      now: () => NOW,
    });

    expect(rows).toEqual([
      {
        event_id: "evt_1",
        source_id: "src_1",
        received_at: "2026-05-15 11:55:00.000",
        size_bytes: 2048,
        last_attempt_at: "2026-05-15 12:00:00.000",
        delivery_status_by_destination: {
          dst_pg: "success",
          dst_s3: "retry",
        },
      },
    ]);
    expect(calls[0]?.params).toMatchObject({
      workspace_id: "ws_test",
      route_id: "rt_test",
      limit: 30,
      since: "2026-05-14T12:00:00.000Z",
    });
    expect(calls[0]?.sql).toContain("WITH recent_events AS");
    expect(calls[0]?.sql).toContain("SELECT r.event_id AS event_id");
    expect(calls[0]?.sql).toContain("created_at >= parseDateTime64BestEffort({since:String}, 3)");
    expect(calls[0]?.sql).toContain("LIMIT {limit:UInt32}");
  });

  it("listWorkspaceEvents queries a plain bounded page when no filters are given", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          {
            event_id: "evt_1",
            source_id: "src_1",
            received_at: "2026-05-15 11:55:00.000",
            content_type: "application/json",
            size_bytes: "2048",
            shard: "3",
            r2_key: "ws/evt_1",
          },
        ],
      ],
    });

    const rows = await listWorkspaceEvents("ws_test", { limit: 100 }, { clickhouse: client });

    expect(rows).toEqual([
      {
        event_id: "evt_1",
        source_id: "src_1",
        received_at: "2026-05-15 11:55:00.000",
        content_type: "application/json",
        size_bytes: 2048,
        shard: 3,
        r2_key: "ws/evt_1",
      },
    ]);
    expect(calls[0]?.params).toEqual({ workspace_id: "ws_test", limit: 100 });
    expect(calls[0]?.sql).toContain("WHERE workspace_id = {workspace_id:String}");
    expect(calls[0]?.sql).toContain("ORDER BY received_at DESC, event_id DESC");
    expect(calls[0]?.sql).toContain("LIMIT {limit:UInt32}");
    expect(calls[0]?.sql).not.toContain("source_id = {source_id:String}");
    expect(calls[0]?.sql).not.toContain("content_type = {content_type:String}");
    expect(calls[0]?.sql).not.toContain("positionCaseInsensitive");
    expect(calls[0]?.sql).not.toContain("before_received_at");
  });

  it("keeps historical request metadata out of event detail", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [[{
        event_id: "evt_1",
        source_id: "src_1",
        workspace_id: "ws_test",
        received_at: "2026-05-15 11:55:00.000",
        content_type: "application/json",
        size_bytes: "2048",
        shard: "3",
        r2_key: "events/ws_test/2026-05-15/evt_1",
        headers_json: JSON.stringify({ "x-customer-ref": "historical-secret" }),
        query_json: JSON.stringify({ campaign: "historical-query-secret" }),
      }]],
    });

    const detail = await getEventDetail("ws_test", "evt_1", { clickhouse: client });

    expect(detail?.headers).toEqual({});
    expect(detail?.query).toEqual({});
    expect(calls[0]?.sql).not.toContain("headers_json");
    expect(calls[0]?.sql).not.toContain("query_json");
  });

  it("listWorkspaceEvents pushes source/content-type/search filters into the query as bound parameters", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[]] });

    await listWorkspaceEvents(
      "ws_test",
      { limit: 50, sourceId: "src_stripe", contentType: "application/json", search: "evt_ab'; DROP" },
      { clickhouse: client },
    );

    expect(calls[0]?.params).toEqual({
      workspace_id: "ws_test",
      limit: 50,
      source_id: "src_stripe",
      content_type: "application/json",
      q: "evt_ab'; DROP",
    });
    expect(calls[0]?.sql).toContain("AND source_id = {source_id:String}");
    expect(calls[0]?.sql).toContain("AND content_type = {content_type:String}");
    expect(calls[0]?.sql).toContain(
      "positionCaseInsensitive(concatWithSeparator(' ', event_id, source_id, content_type), {q:String}) > 0",
    );
    // User input is only ever bound, never inlined into the SQL text.
    expect(calls[0]?.sql).not.toContain("src_stripe");
    expect(calls[0]?.sql).not.toContain("DROP");
  });

  it("listWorkspaceEvents applies the keyset cursor as a (received_at, event_id) tuple comparison", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[]] });

    await listWorkspaceEvents(
      "ws_test",
      { limit: 100, before: { receivedAt: "2026-05-15T11:55:00.000Z", eventId: "evt_50" } },
      { clickhouse: client },
    );

    expect(calls[0]?.params).toEqual({
      workspace_id: "ws_test",
      limit: 100,
      before_received_at: "2026-05-15T11:55:00.000Z",
      before_event_id: "evt_50",
    });
    expect(calls[0]?.sql).toContain(
      "AND (received_at, event_id) < (parseDateTime64BestEffort({before_received_at:String}, 3), {before_event_id:String})",
    );
  });

  it("listWorkspaceEvents falls back to a timestamp-only cursor when no tie-break event id is given", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[]] });

    await listWorkspaceEvents(
      "ws_test",
      { before: { receivedAt: "2026-05-15T11:55:00.000Z" } },
      { clickhouse: client },
    );

    expect(calls[0]?.params).toEqual({
      workspace_id: "ws_test",
      limit: 100,
      before_received_at: "2026-05-15T11:55:00.000Z",
    });
    expect(calls[0]?.sql).toContain(
      "AND received_at < parseDateTime64BestEffort({before_received_at:String}, 3)",
    );
    expect(calls[0]?.sql).not.toContain("{before_event_id:String}");
  });

  it("listWorkspaceEvents composes filters and cursor in a single WHERE clause", async () => {
    const { client, calls } = fakeClickhouse({ responses: [[]] });

    await listWorkspaceEvents(
      "ws_test",
      {
        limit: 101,
        sourceId: "src_github",
        contentType: "application/json",
        search: "push",
        before: { receivedAt: "2026-05-15T11:55:00.000Z", eventId: "evt_50" },
      },
      { clickhouse: client },
    );

    const sql = calls[0]?.sql ?? "";
    expect(sql).toContain("workspace_id = {workspace_id:String}");
    expect(sql).toContain("AND source_id = {source_id:String}");
    expect(sql).toContain("AND content_type = {content_type:String}");
    expect(sql).toContain("AND positionCaseInsensitive");
    expect(sql).toContain("AND (received_at, event_id) <");
    expect(calls[0]?.params.limit).toBe(101);
  });

  it("listWorkspaceEventFacets returns sorted distinct sources and content types over the retention window", async () => {
    const { client, calls } = fakeClickhouse({
      responses: [
        [
          { source_id: "src_stripe", content_type: "application/json" },
          { source_id: "src_github", content_type: "application/json" },
          { source_id: "src_stripe", content_type: "application/x-www-form-urlencoded" },
          { source_id: "", content_type: "" },
        ],
      ],
    });

    const facets = await listWorkspaceEventFacets("ws_test", { clickhouse: client });

    expect(facets).toEqual({
      sourceIds: ["src_github", "src_stripe"],
      contentTypes: ["application/json", "application/x-www-form-urlencoded"],
    });
    expect(calls[0]?.params).toEqual({ workspace_id: "ws_test" });
    expect(calls[0]?.sql).toContain("SELECT DISTINCT source_id, content_type");
    expect(calls[0]?.sql).toContain("WHERE workspace_id = {workspace_id:String}");
  });

  it("getWorkspaceUsage handles previous-month rollover near month boundary", async () => {
    const { client } = fakeClickhouse({
      responses: [
        [{ events: "100", bytes: "5000" }],
        [{ c: "200" }],
        [{ c: "10" }],
        [{ attempts: "100", success: "100", retries: "0", dead: "0" }],
      ],
    });

    const jan1 = new Date("2026-01-01T00:30:00Z");
    const summary = await getWorkspaceUsage("ws_test", { clickhouse: client, now: () => jan1 });

    expect(summary.windowStart).toBe("2026-01-01T00:00:00.000Z");
    expect(summary.windowEnd).toBe("2026-02-01T00:00:00.000Z");
    expect(summary.eventsPreviousMonth).toBe(200);
  });

  describe("canonical latest-outcome composition", () => {
    // The three outcome surfaces (month summary, failure-type breakdown,
    // daily delivery chart) must be built from the exact same CTE — modulo
    // their outer aggregation — so success can never mean different things
    // on different dashboard cards.

    async function collectRollupSql(): Promise<string[]> {
      const usage = fakeClickhouse({
        responses: [[{ events: "1", bytes: "1" }], [{ c: "1" }], [{ c: "1" }], []],
      });
      await getWorkspaceUsage("ws_test", { clickhouse: usage.client, now: () => NOW });

      const failures = fakeClickhouse({ responses: [[]] });
      await listWorkspaceFailureTypes("ws_test", { clickhouse: failures.client, now: () => NOW });

      const daily = fakeClickhouse({ responses: [[]] });
      await getDailyDeliveryStats("ws_test", 14, { clickhouse: daily.client, now: () => NOW });

      return [usage.calls[3]!.sql, failures.calls[0]!.sql, daily.calls[0]!.sql];
    }

    async function collectFallbackSql(): Promise<string[]> {
      // getWorkspaceUsage fires 4 rollup queries first (calls 0-3); only the
      // deliveries rollup fails, so call 4 is its raw-attempts fallback.
      const usage = fakeClickhouse({
        responses: [
          [{ events: "1", bytes: "1" }],
          [{ c: "1" }],
          [{ c: "1" }],
          new Error("UNKNOWN_TABLE"),
          [],
        ] as never,
      });
      await getWorkspaceUsage("ws_test", { clickhouse: usage.client, now: () => NOW });

      const failures = fakeClickhouse({ responses: [new Error("UNKNOWN_TABLE"), []] as never });
      await listWorkspaceFailureTypes("ws_test", { clickhouse: failures.client, now: () => NOW });

      const daily = fakeClickhouse({ responses: [new Error("UNKNOWN_TABLE"), []] as never });
      await getDailyDeliveryStats("ws_test", 14, { clickhouse: daily.client, now: () => NOW });

      return [usage.calls[4]!.sql, failures.calls[1]!.sql, daily.calls[1]!.sql];
    }

    it("all three rollup surfaces embed the identical rollup CTE and canonical predicates", async () => {
      const rollupCte = latestOutcomesCTE({ source: "rollup" });
      const [totalsSql, failuresSql, dailySql] = await collectRollupSql();
      for (const sql of [totalsSql, failuresSql, dailySql]) {
        expect(sql).toContain(rollupCte);
        expect(sql).toContain(SUCCESS_PREDICATE);
        expect(sql).toContain("GROUP BY base_event_id, route_id, destination_id");
      }
      // The counting surfaces also share the canonical terminal-failure split.
      expect(totalsSql).toContain(TERMINAL_FAILURE_PREDICATE);
      expect(dailySql).toContain(TERMINAL_FAILURE_PREDICATE);
      expect(failuresSql).toContain(`NOT ${SUCCESS_PREDICATE}`);
    });

    it("all three raw fallbacks embed the identical attempts CTE with replay-id normalization", async () => {
      const attemptsCte = latestOutcomesCTE({ source: "attempts" });
      for (const sql of await collectFallbackSql()) {
        expect(sql).toContain(attemptsCte);
        expect(sql).toContain(BASE_EVENT_ID_EXPR);
        expect(sql).toContain("replaceRegexpOne(event_id, '#rpy_[A-Za-z0-9_-]+$', '')");
        expect(sql).toContain(SUCCESS_PREDICATE);
        expect(sql).toContain("GROUP BY base_event_id, route_id, destination_id");
      }
    });

    it("getWorkspaceUsage raw fallback collapses replays like the other surfaces (drift fix)", async () => {
      const [usageSql] = await collectFallbackSql();
      // Previously this block grouped by raw event_id, so a replayed event
      // counted as a second delivery in the headline success rate only.
      expect(usageSql).not.toContain("GROUP BY event_id, route_id, destination_id");
      expect(usageSql).toContain(BASE_EVENT_ID_EXPR);
      // Upper bound stays on the collapsed outcome, outside the inner scan.
      expect(usageSql).toContain("WHERE outcome_at < parseDateTime64BestEffort({end:String}, 3)");
    });

    it("getWorkspaceUsage assembles the summary from the fallback rows when the rollup is missing", async () => {
      const { client, calls } = fakeClickhouse({
        responses: [
          [{ events: "100", bytes: "5000" }],
          [{ c: "90" }],
          [{ c: "10" }],
          new Error("UNKNOWN_TABLE"),
          [{ attempts: "50", success: "48", retries: "1", dead: "1" }],
        ] as never,
      });

      const summary = await getWorkspaceUsage("ws_test", { clickhouse: client, now: () => NOW });

      expect(calls).toHaveLength(5);
      expect(summary.deliveryAttemptsThisMonth).toBe(50);
      expect(summary.deliveriesSucceededThisMonth).toBe(48);
      expect(summary.retriesThisMonth).toBe(1);
      expect(summary.deadDeliveriesThisMonth).toBe(1);
    });
  });
});
