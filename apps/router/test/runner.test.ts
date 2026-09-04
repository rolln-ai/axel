import { describe, expect, it } from "vitest";
import { startPeriodicRunner, type AlertEvent, type AlertSink, type PeriodicJob, type RunnerOptions } from "../src/index.ts";

interface FakeScheduler {
  setIntervalImpl: NonNullable<RunnerOptions["setIntervalImpl"]>;
  clearIntervalImpl: NonNullable<RunnerOptions["clearIntervalImpl"]>;
  setTimeoutImpl: NonNullable<RunnerOptions["setTimeoutImpl"]>;
  clearTimeoutImpl: NonNullable<RunnerOptions["clearTimeoutImpl"]>;
  /** Manually fire all registered intervals once. */
  tickAll(): void;
  /** Manually fire all registered timeouts once. */
  flushTimeouts(): void;
  intervalCount(): number;
}

function fakeScheduler(): FakeScheduler {
  let intervalSeq = 0;
  let timeoutSeq = 0;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();
  return {
    setIntervalImpl(handler) {
      const id = ++intervalSeq;
      intervals.set(id, handler);
      return id;
    },
    clearIntervalImpl(handle) {
      intervals.delete(handle as number);
    },
    setTimeoutImpl(handler) {
      const id = ++timeoutSeq;
      timeouts.set(id, handler);
      return id;
    },
    clearTimeoutImpl(handle) {
      timeouts.delete(handle as number);
    },
    tickAll() {
      for (const handler of intervals.values()) handler();
    },
    flushTimeouts() {
      const fns = [...timeouts.values()];
      timeouts.clear();
      for (const fn of fns) fn();
    },
    intervalCount() {
      return intervals.size;
    },
  };
}

async function flushMicrotasks(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
}

function captureAlerts(): AlertSink & { events: AlertEvent[] } {
  const events: AlertEvent[] = [];
  return {
    events,
    async notify(event) {
      events.push(event);
    },
  };
}

describe("startPeriodicRunner", () => {
  it("registers one interval per job", () => {
    const sched = fakeScheduler();
    const handle = startPeriodicRunner(
      [
        { name: "a", intervalMs: 1000, run: async () => {} },
        { name: "b", intervalMs: 2000, run: async () => {} },
      ],
      sched,
    );
    expect(sched.intervalCount()).toBe(2);
    return handle.stop();
  });

  it("runs each job's run() on every tick and updates stats", async () => {
    const sched = fakeScheduler();
    let aHits = 0;
    let bHits = 0;
    const handle = startPeriodicRunner(
      [
        { name: "a", intervalMs: 1000, run: async () => { aHits += 1; } },
        { name: "b", intervalMs: 2000, run: async () => { bHits += 1; } },
      ],
      sched,
    );

    // Two ticks separated by a microtask drain so the in-flight check
    // doesn't skip the second tick (that's the no-overlap behavior, covered
    // in its own test below).
    sched.tickAll();
    await flushMicrotasks();
    sched.tickAll();
    await flushMicrotasks();

    expect(aHits).toBe(2);
    expect(bHits).toBe(2);
    expect(handle.stats()["a"]?.runs).toBe(2);
    expect(handle.stats()["b"]?.runs).toBe(2);

    await handle.stop();
  });

  it("reports failures via the alert sink and increments failure count without re-throwing", async () => {
    const sched = fakeScheduler();
    const sink = captureAlerts();
    const handle = startPeriodicRunner(
      [{ name: "broken", intervalMs: 1000, run: async () => { throw new Error("boom"); } }],
      { ...sched, alertSink: sink },
    );

    sched.tickAll();
    await flushMicrotasks();

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.rule).toBe("periodic_job_failure");
    expect(sink.events[0]?.severity).toBe("warn");
    expect(sink.events[0]?.summary).toBe("Periodic background job failed.");
    expect(JSON.stringify(sink.events[0])).not.toContain("boom");
    expect(handle.stats()["broken"]?.failures).toBe(1);
    expect(handle.stats()["broken"]?.runs).toBe(1);

    await handle.stop();
  });

  it("skips a tick if the previous run is still in flight (no overlap)", async () => {
    const sched = fakeScheduler();
    let resolveSlow: (() => void) | null = null;
    const slowPromise = new Promise<void>((resolve) => {
      resolveSlow = resolve;
    });
    let runs = 0;

    const job: PeriodicJob = {
      name: "slow",
      intervalMs: 1000,
      run: async () => {
        runs += 1;
        await slowPromise;
      },
    };
    const handle = startPeriodicRunner([job], sched);

    sched.tickAll(); // starts run #1 (in flight)
    await Promise.resolve();
    sched.tickAll(); // tick #2 should be skipped
    await Promise.resolve();
    sched.tickAll(); // tick #3 also skipped
    await Promise.resolve();
    expect(runs).toBe(1);
    expect(handle.stats()["slow"]?.skipped).toBe(2);

    resolveSlow!();
    // Let the in-flight run settle so stats reflect completion.
    await flushMicrotasks();
    expect(handle.stats()["slow"]?.runs).toBe(1);

    sched.tickAll(); // now the next tick can run
    await flushMicrotasks();
    expect(runs).toBe(2);

    await handle.stop();
  });

  it("runOnStart fires one immediate run via setTimeout(0)", async () => {
    const sched = fakeScheduler();
    let hits = 0;
    const handle = startPeriodicRunner(
      [{ name: "boot", intervalMs: 60_000, runOnStart: true, run: async () => { hits += 1; } }],
      sched,
    );

    sched.flushTimeouts();
    await flushMicrotasks();
    expect(hits).toBe(1);
    await handle.stop();
  });

  it("stop() awaits in-flight jobs and prevents future ticks", async () => {
    const sched = fakeScheduler();
    let resolveRun: (() => void) | null = null;
    let runs = 0;
    const handle = startPeriodicRunner(
      [{
        name: "slow",
        intervalMs: 1000,
        run: async () => {
          runs += 1;
          await new Promise<void>((resolve) => {
            resolveRun = resolve;
          });
        },
      }],
      sched,
    );

    sched.tickAll();
    await Promise.resolve();

    // Stop is initiated while one run is still in flight. It should NOT resolve
    // until we let that run complete.
    let stopResolved = false;
    const stopPromise = handle.stop().then(() => { stopResolved = true; });
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    resolveRun!();
    await stopPromise;
    expect(stopResolved).toBe(true);

    // Ticking after stop must be a no-op for run().
    sched.tickAll();
    await Promise.resolve();
    expect(runs).toBe(1);
  });
});
