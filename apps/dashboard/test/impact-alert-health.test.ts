import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETED_DELIVERIES_SQL, FLOW_ACTIVITY_SQL, FLOW_HISTORY_SQL, DELIVERY_ACTIVITY_SQL, UNATTEMPTED_SQL } from "../lib/impact-alert-queries";
import { loadImpactObservations } from "../lib/impact-alert-health";

const { pgQuery, chQuery } = vi.hoisted(() => ({ pgQuery: vi.fn(), chQuery: vi.fn() }));
vi.mock("../lib/db", () => ({ db: () => ({ query: pgQuery }) }));
vi.mock("../lib/clickhouse", () => ({ clickhouse: () => ({ query: chQuery }) }));

const last = Date.parse("2030-01-28T17:00:00Z");
const source = { id: "src_a", name: "Orders", created_at: "2030-01-01", alert_after_minutes: null, flow_monitoring_enabled: true };
const flow = { source_id: source.id, last_received: new Date(last).toISOString(), samples: 2000, typical_gap_seconds: 60 };
const buckets = Array.from({ length: 25 }, (_, day) => [last - day * 86_400_000, last - day * 86_400_000]);

describe("history in the live impact monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(last + 2 * 3_600_000);
    pgQuery.mockReset();
    chQuery.mockReset();
    pgQuery.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    chQuery.mockImplementation(async (sql: string, params: Record<string, string>) => {
      expect(params.workspace_id).toBe("ws_a");
      if (sql === FLOW_ACTIVITY_SQL) return { rows: [flow] };
      if (sql === FLOW_HISTORY_SQL) return { rows: [{ source_id: source.id, buckets }] };
      if (sql === DELIVERY_ACTIVITY_SQL) return { rows: [] };
      throw new Error("Unexpected analytics query");
    });
  });
  afterEach(() => vi.useRealTimers());

  it("uses the source's historical quiet periods in automatic observations", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [] });
    const observation = (await loadImpactObservations("ws_a"))[0]!;
    expect(observation.unhealthy).toBe(false);
    expect(observation.snapshot.thresholdBasis).toBe("historical_pattern");
  });

  it("cannot recover an existing incident from a larger learned window without new accepted traffic", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ incident_key: `source:${source.id}`,
      opened_at: new Date(last + 31 * 60_000).toISOString(), snapshot: { lastReceived: flow.last_received, thresholdMinutes: 30 } }] });
    const observation = (await loadImpactObservations("ws_a"))[0]!;
    expect(observation.unhealthy).toBe(true);
    expect(observation.snapshot.thresholdMinutes).toBe(30);
  });

  it("recovers an incident on a source in its learning window once new traffic is accepted", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ incident_key: `source:${source.id}`, opened_at: new Date(last - 3_600_000).toISOString(),
      snapshot: { sourceId: source.id, sourceName: source.name, lastReceived: null, thresholdMinutes: 30, failedCount: 0, waitingCount: 0 } }] });
    const implementation = chQuery.getMockImplementation()!;
    chQuery.mockImplementation((sql, params) => sql === FLOW_HISTORY_SQL
      ? Promise.resolve({ rows: [{ source_id: source.id, buckets: buckets.slice(0, 3) }] }) : implementation(sql, params));
    const observation = (await loadImpactObservations("ws_a"))[0]!;
    expect(observation.key).toBe(`source:${source.id}`);
    expect(observation.unhealthy).toBe(false);
    expect(observation.snapshot.lastReceived).toBe(flow.last_received);
  });

  it("leaves an incident open, with no healthy check, while a learning source has accepted nothing new", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ incident_key: `source:${source.id}`, opened_at: new Date(last + 31 * 60_000).toISOString(),
      snapshot: { sourceId: source.id, sourceName: source.name, lastReceived: flow.last_received, thresholdMinutes: 30, failedCount: 0, waitingCount: 0 } }] });
    const implementation = chQuery.getMockImplementation()!;
    chQuery.mockImplementation((sql, params) => sql === FLOW_HISTORY_SQL
      ? Promise.resolve({ rows: [{ source_id: source.id, buckets: buckets.slice(0, 3) }] }) : implementation(sql, params));
    expect(await loadImpactObservations("ws_a")).toEqual([]);
  });

  it("keeps history lookup failures unavailable instead of reporting a healthy source", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [] });
    const implementation = chQuery.getMockImplementation()!;
    chQuery.mockImplementation((sql, params) => sql === FLOW_HISTORY_SQL
      ? Promise.reject(new Error("Analytics unavailable")) : implementation(sql, params));
    await expect(loadImpactObservations("ws_a")).rejects.toThrow("Analytics unavailable");
  });

  it("does not borrow another source's history", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [] });
    const implementation = chQuery.getMockImplementation()!;
    chQuery.mockImplementation((sql, params) => sql === FLOW_HISTORY_SQL
      ? Promise.resolve({ rows: [{ source_id: "src_other", buckets }] }) : implementation(sql, params));
    const observation = (await loadImpactObservations("ws_a"))[0]!;
    expect(observation.unhealthy).toBe(true);
    expect(observation.snapshot.thresholdMinutes).toBe(30);
  });

  it("keeps an open source incident unhealthy when receipt history ages out", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ incident_key: `source:${source.id}`,
      opened_at: new Date(last + 31 * 60_000).toISOString(), snapshot: { lastReceived: flow.last_received, thresholdMinutes: 30 } }] });
    chQuery.mockResolvedValue({ rows: [] });
    vi.setSystemTime(last + 40 * 86_400_000);
    const observation = (await loadImpactObservations("ws_a"))[0]!;
    expect(observation.unhealthy).toBe(true);
  });
});

describe("missing delivery records in the live impact monitor", () => {
  const route = { id: "rt_a", source_id: source.id, destination_id: "dst_a", destination_name: "Warehouse",
    paused: false, route_errored: false, unconditional: true, created_at: "2030-01-01" };
  const key = `delivery:${route.id}:${route.destination_id}`;
  const outcome = { route_id: route.id, destination_id: route.destination_id, last_delivered: flow.last_received,
    waiting_count: 0, schema_failures: 0, auth_failures: 0 };
  let missing: { waiting_count: number; event_ids: string[] };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(last + 2 * 3_600_000);
    pgQuery.mockReset();
    chQuery.mockReset();
    missing = { waiting_count: 1, event_ids: ["evt_lost"] };
    route.paused = false;
    route.route_errored = false;
    pgQuery.mockResolvedValueOnce({ rows: [source] }).mockResolvedValueOnce({ rows: [route] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    chQuery.mockImplementation(async (sql: string, params: Record<string, string>) => {
      expect(params.workspace_id).toBe("ws_a");
      if (sql === FLOW_ACTIVITY_SQL) return { rows: [flow] };
      if (sql === FLOW_HISTORY_SQL) return { rows: [{ source_id: source.id, buckets }] };
      if (sql === DELIVERY_ACTIVITY_SQL) return { rows: [outcome] };
      if (sql === UNATTEMPTED_SQL) {
        expect(params.route_id).toBe(route.id);
        expect(params.destination_id).toBe(route.destination_id);
        return { rows: [missing] };
      }
      throw new Error("Unexpected analytics query");
    });
  });
  afterEach(() => vi.useRealTimers());

  it("does not count an accepted event whose delivery claim settled as completed", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ count: "1" }] });
    const observation = (await loadImpactObservations("ws_a")).find(o => o.key === key)!;
    expect(pgQuery).toHaveBeenLastCalledWith(COMPLETED_DELIVERIES_SQL, ["ws_a", route.id, route.destination_id, ["evt_lost"]]);
    expect(observation.snapshot.waitingCount).toBe(0);
    expect(observation.unhealthy).toBe(false);
    expect(observation.snapshot.cause).toBe("delivery_failed");
  });

  it("still reports an accepted event with no attempt and no completed claim", async () => {
    pgQuery.mockResolvedValueOnce({ rows: [{ count: "0" }] });
    const observation = (await loadImpactObservations("ws_a")).find(o => o.key === key)!;
    expect(observation.snapshot.waitingCount).toBe(1);
    expect(observation.unhealthy).toBe(true);
    expect(observation.snapshot.cause).toBe("backlog");
  });

  it("keeps counting ids beyond the retained candidates", async () => {
    missing = { waiting_count: 1002, event_ids: ["evt_lost", "evt_other"] };
    pgQuery.mockResolvedValueOnce({ rows: [{ count: "2" }] });
    const observation = (await loadImpactObservations("ws_a")).find(o => o.key === key)!;
    expect(observation.snapshot.waitingCount).toBe(1000);
    expect(observation.unhealthy).toBe(true);
  });

  it("does not consult Postgres when analytics reports no missing deliveries", async () => {
    missing = { waiting_count: 0, event_ids: [] };
    const observation = (await loadImpactObservations("ws_a")).find(o => o.key === key)!;
    expect(pgQuery).toHaveBeenCalledTimes(4);
    expect(observation.snapshot.waitingCount).toBe(0);
    expect(observation.unhealthy).toBe(false);
  });

  it("keeps a Postgres failure unavailable instead of reporting a healthy route", async () => {
    pgQuery.mockRejectedValueOnce(new Error("Control plane unavailable"));
    await expect(loadImpactObservations("ws_a")).rejects.toThrow("Control plane unavailable");
  });

  it("identifies an errored route without claiming its healthy destination is paused", async () => {
    route.route_errored = true;
    missing = { waiting_count: 0, event_ids: [] };
    const observation = (await loadImpactObservations("ws_a")).find(o => o.key === key)!;
    expect(observation.unhealthy).toBe(true);
    expect(observation.snapshot.cause).toBe("route_errored");
  });

  it("still identifies an actual destination pause separately", async () => {
    route.paused = true;
    missing = { waiting_count: 0, event_ids: [] };
    const observation = (await loadImpactObservations("ws_a")).find(o => o.key === key)!;
    expect(observation.unhealthy).toBe(true);
    expect(observation.snapshot.cause).toBe("destination_paused");
  });
});
