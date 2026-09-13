import { describe, expect, it, vi } from "vitest";
import type { AlertEvent, AlertSink } from "@axel/router";
import { createQueueLagMonitor } from "../src/queue-lag-monitor.ts";

function isoAgo(nowMs: number, seconds: number): string {
  return new Date(nowMs - seconds * 1000).toISOString();
}

const NOW = 1_700_000_000_000;

// DEFAULT_THRESHOLDS: queue_lag_seconds_warn=60, queue_lag_seconds_critical=300.

describe("createQueueLagMonitor", () => {
  it("does not emit when lag is below the warn threshold", async () => {
    const notify = vi.fn<(e: AlertEvent) => Promise<void>>(async () => {});
    const mon = createQueueLagMonitor({ sink: { notify } as AlertSink, now: () => NOW });
    await mon.observe([{ enqueued_at: isoAgo(NOW, 30) }]);
    expect(notify).not.toHaveBeenCalled();
  });

  it("emits a warn alert when the oldest message exceeds the warn threshold", async () => {
    const events: AlertEvent[] = [];
    const mon = createQueueLagMonitor({
      sink: { notify: async (e) => void events.push(e) },
      now: () => NOW,
    });
    await mon.observe([{ enqueued_at: isoAgo(NOW, 120) }, { enqueued_at: isoAgo(NOW, 10) }]);
    expect(events).toHaveLength(1);
    expect(events[0]!.rule).toBe("queue_lag");
    expect(events[0]!.severity).toBe("warn");
    expect(events[0]!.details.oldest_unacked_age_seconds).toBe(120);
  });

  it("emits critical when the oldest message exceeds the critical threshold", async () => {
    const events: AlertEvent[] = [];
    const mon = createQueueLagMonitor({
      sink: { notify: async (e) => void events.push(e) },
      now: () => NOW,
    });
    await mon.observe([{ enqueued_at: isoAgo(NOW, 400) }]);
    expect(events[0]!.severity).toBe("critical");
  });

  it("emits from realtime provider metrics even when no message was leased", async () => {
    const events: AlertEvent[] = [];
    const mon = createQueueLagMonitor({
      sink: { notify: async (e) => void events.push(e) },
      now: () => NOW,
    });
    await mon.observeSnapshot({
      oldest_unacked_age_seconds: 400,
      backlog: 75,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ severity: "critical", rule: "queue_lag" });
    expect(events[0]!.details.backlog).toBe(75);
  });

  it("throttles repeated emits within throttleMs", async () => {
    let now = NOW;
    const notify = vi.fn<(e: AlertEvent) => Promise<void>>(async () => {});
    const mon = createQueueLagMonitor({ sink: { notify } as AlertSink, throttleMs: 60_000, now: () => now });
    await mon.observe([{ enqueued_at: isoAgo(now, 400) }]);
    expect(notify).toHaveBeenCalledTimes(1);
    now += 30_000; // within throttle window
    await mon.observe([{ enqueued_at: isoAgo(now, 400) }]);
    expect(notify).toHaveBeenCalledTimes(1);
    now += 40_000; // past throttle window
    await mon.observe([{ enqueued_at: isoAgo(now, 400) }]);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("keeps pulled-message alerts and their throttle working through unknown provider ages", async () => {
    let now = NOW;
    const notify = vi.fn<(e: AlertEvent) => Promise<void>>(async () => {});
    const mon = createQueueLagMonitor({ sink: { notify }, now: () => now });
    const unknown = { oldest_unacked_age_seconds: null, backlog: 75 };
    await mon.observeSnapshot(unknown);
    expect(notify).not.toHaveBeenCalled();
    await mon.observe([{ enqueued_at: isoAgo(now, 400) }]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toMatchObject({ rule: "queue_lag", severity: "critical" });
    now += 30_000;
    await mon.observeSnapshot(unknown);
    await mon.observe([{ enqueued_at: isoAgo(now, 400) }]);
    expect(notify).toHaveBeenCalledTimes(1);
    now += 31_000;
    await mon.observeSnapshot({ oldest_unacked_age_seconds: 400, backlog: 75 });
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("ignores empty batches and missing timestamps", async () => {
    const notify = vi.fn<(e: AlertEvent) => Promise<void>>(async () => {});
    const mon = createQueueLagMonitor({ sink: { notify } as AlertSink, now: () => NOW });
    await mon.observe([]);
    await mon.observe([{}, { enqueued_at: undefined }]);
    expect(notify).not.toHaveBeenCalled();
  });
});
