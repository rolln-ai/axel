import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLOW_ACTIVITY_SQL, FLOW_HISTORY_SQL, DELIVERY_ACTIVITY_SQL } from "../lib/impact-alert-queries";
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
