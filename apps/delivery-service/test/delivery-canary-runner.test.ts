import type { CronCheckInInput, SentryClient } from "@axel/observability";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DELIVERY_CANARY_INTERVAL_MS,
  deliveryCanaryEnabled,
  deliveryCanaryIntervalMs,
  MAX_DELIVERY_CANARY_INTERVAL_MS,
  MIN_DELIVERY_CANARY_INTERVAL_MS,
  runDeliveryCanaryTick,
  startDeliveryCanaryLoop,
} from "../src/delivery-canary-runner.ts";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function capturingSentry(checkIns: CronCheckInInput[]): SentryClient {
  return {
    async captureCheckIn(input) {
      checkIns.push(input);
      return input.status === "in_progress" ? "check_in_test" : "ignored";
    },
    async captureException() {},
    async captureMessage() {},
    async captureTransaction() {},
  };
}

describe("deliveryCanaryIntervalMs", () => {
  it("requires both the singleton worker role and the exact opt-in value", () => {
    expect(deliveryCanaryEnabled(true, { AXEL_CANARY_ENABLED: "1" })).toBe(true);
    expect(deliveryCanaryEnabled(false, { AXEL_CANARY_ENABLED: "1" })).toBe(false);
    expect(deliveryCanaryEnabled(true, { AXEL_CANARY_ENABLED: "true" })).toBe(false);
    expect(deliveryCanaryEnabled(true, {})).toBe(false);
  });

  it("defaults to 15 minutes and bounds configured intervals", () => {
    expect(deliveryCanaryIntervalMs({})).toBe(
      DEFAULT_DELIVERY_CANARY_INTERVAL_MS,
    );
    expect(deliveryCanaryIntervalMs({ AXEL_CANARY_INTERVAL_MS: "invalid" }))
      .toBe(DEFAULT_DELIVERY_CANARY_INTERVAL_MS);
    expect(deliveryCanaryIntervalMs({ AXEL_CANARY_INTERVAL_MS: "1" })).toBe(
      MIN_DELIVERY_CANARY_INTERVAL_MS,
    );
    expect(deliveryCanaryIntervalMs({ AXEL_CANARY_INTERVAL_MS: "999999999" }))
      .toBe(MAX_DELIVERY_CANARY_INTERVAL_MS);
  });
});

describe("runDeliveryCanaryTick", () => {
  it("uses the existing canary with quiet logs and an interval Sentry monitor", async () => {
    const checkIns: CronCheckInInput[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const runCanary = vi.fn(async (options) => {
      options?.log?.("probe and event identifiers");
      options?.errorLog?.("probe and event identifiers");
    });
    const controller = new AbortController();

    try {
      await runDeliveryCanaryTick({
        sentry: capturingSentry(checkIns),
        env: {},
        intervalMs: DEFAULT_DELIVERY_CANARY_INTERVAL_MS,
        runCanary,
        signal: controller.signal,
      });
    } finally {
      consoleLog.mockRestore();
      consoleError.mockRestore();
    }

    expect(runCanary).toHaveBeenCalledOnce();
    expect(runCanary.mock.calls[0]![0]?.signal).toBe(controller.signal);
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    expect(checkIns).toEqual([
      {
        monitor_slug: "production-delivery-canary",
        status: "in_progress",
        monitor_config: {
          schedule: { type: "interval", value: 15, unit: "minute" },
          checkin_margin: 5,
          max_runtime: 10,
          timezone: "UTC",
        },
      },
      {
        monitor_slug: "production-delivery-canary",
        status: "ok",
        check_in_id: "check_in_test",
        duration: expect.any(Number),
      },
    ]);
  });

  it("reports an error check-in when the canary fails", async () => {
    const checkIns: CronCheckInInput[] = [];
    await expect(runDeliveryCanaryTick({
      sentry: capturingSentry(checkIns),
      env: {},
      runCanary: async () => {
        throw new Error("sensitive failure detail");
      },
    })).rejects.toThrow("sensitive failure detail");

    expect(checkIns.map((input) => input.status)).toEqual([
      "in_progress",
      "error",
    ]);
  });
});

describe("startDeliveryCanaryLoop", () => {
  it("delays the first run, never overlaps, and aborts an active run on stop", async () => {
    const firstRun = deferred();
    let concurrent = 0;
    let maxConcurrent = 0;
    const observedSignals: AbortSignal[] = [];
    const runCanary = vi.fn(async (options) => {
      const signal = options?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      observedSignals.push(signal!);
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        if (runCanary.mock.calls.length === 1) {
          await firstRun.promise;
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          signal!.addEventListener(
            "abort",
            () => reject(new Error("canary_aborted")),
            { once: true },
          );
        });
      } finally {
        concurrent -= 1;
      }
    });
    const timers: Array<{
      callback: () => void;
      delayMs: number;
      handle: { unref(): void };
    }> = [];
    const cleared: unknown[] = [];

    const handle = startDeliveryCanaryLoop({
      sentry: null,
      env: {},
      intervalMs: DEFAULT_DELIVERY_CANARY_INTERVAL_MS,
      runCanary,
      setTimeoutImpl(callback, delayMs) {
        const handle = { unref() {} };
        timers.push({ callback, delayMs, handle });
        return handle;
      },
      clearTimeoutImpl(timer) {
        cleared.push(timer);
      },
    });

    expect(runCanary).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.delayMs).toBe(DEFAULT_DELIVERY_CANARY_INTERVAL_MS);
    timers.shift()!.callback();
    await vi.waitFor(() => expect(runCanary).toHaveBeenCalledTimes(1));
    expect(timers).toHaveLength(0);

    firstRun.resolve();
    await vi.waitFor(() => expect(timers).toHaveLength(1));
    expect(timers[0]!.delayMs).toBe(DEFAULT_DELIVERY_CANARY_INTERVAL_MS);
    timers.shift()!.callback();
    await vi.waitFor(() => expect(runCanary).toHaveBeenCalledTimes(2));
    expect(timers).toHaveLength(0);
    expect(maxConcurrent).toBe(1);
    expect(observedSignals[1]!.aborted).toBe(false);

    await handle.stop();

    expect(observedSignals[1]!.aborted).toBe(true);
    expect(timers).toHaveLength(0);
    expect(cleared).toHaveLength(0);
  });

  it("logs only a generic failure and continues on the next interval", async () => {
    const errorLog = vi.fn();
    const timers: Array<() => void> = [];
    const runCanary = vi.fn(async () => {
      throw new Error("token=do-not-log");
    });
    const handle = startDeliveryCanaryLoop({
      sentry: null,
      env: {},
      runCanary,
      errorLog,
      setTimeoutImpl(callback) {
        timers.push(callback);
        return { unref() {} };
      },
    });

    expect(runCanary).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    timers.shift()!();
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledOnce());
    expect(errorLog).toHaveBeenCalledWith("[delivery-canary] check failed");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("do-not-log");
    expect(timers).toHaveLength(1);

    timers.shift()!();
    await vi.waitFor(() => expect(runCanary).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(errorLog).toHaveBeenCalledTimes(2));
    await handle.stop();
  });
});
