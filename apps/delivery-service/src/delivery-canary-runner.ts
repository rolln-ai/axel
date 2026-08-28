import {
  withCronCheckIn,
  type SentryClient,
} from "@axel/observability";
import {
  runDeliveryCanary,
  type DeliveryCanaryOptions,
} from "../../../scripts/delivery-canary.mjs";

export const DEFAULT_DELIVERY_CANARY_INTERVAL_MS = 15 * 60_000;
export const MIN_DELIVERY_CANARY_INTERVAL_MS = 5 * 60_000;
export const MAX_DELIVERY_CANARY_INTERVAL_MS = 60 * 60_000;

const MONITOR_SLUG = "production-delivery-canary";
const NOOP_LOG = () => {};

interface DeliveryCanaryRunnerDeps {
  sentry: SentryClient | null;
  env?: Record<string, string | undefined>;
  intervalMs?: number;
  runCanary?: (options?: DeliveryCanaryOptions) => Promise<unknown>;
  errorLog?: (message: string) => void;
  setTimeoutImpl?: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
}

export interface DeliveryCanaryRunnerHandle {
  stop(): Promise<void>;
}

export function deliveryCanaryEnabled(
  runWorkers: boolean,
  env: Record<string, string | undefined>,
): boolean {
  return runWorkers && env.AXEL_CANARY_ENABLED === "1";
}

export function deliveryCanaryIntervalMs(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AXEL_CANARY_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_DELIVERY_CANARY_INTERVAL_MS;
  }
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured)) {
    return DEFAULT_DELIVERY_CANARY_INTERVAL_MS;
  }
  return Math.min(
    MAX_DELIVERY_CANARY_INTERVAL_MS,
    Math.max(MIN_DELIVERY_CANARY_INTERVAL_MS, configured),
  );
}

export async function runDeliveryCanaryTick(
  deps: Pick<DeliveryCanaryRunnerDeps, "sentry" | "env" | "intervalMs" | "runCanary"> & {
    signal?: AbortSignal;
  },
): Promise<void> {
  const env = deps.env ?? process.env;
  const intervalMs = deps.intervalMs ?? deliveryCanaryIntervalMs(env);
  const runCanary = deps.runCanary ?? runDeliveryCanary;
  await withCronCheckIn(
    deps.sentry,
    {
      slug: MONITOR_SLUG,
      monitorConfig: {
        schedule: {
          type: "interval",
          value: Math.max(1, Math.ceil(intervalMs / 60_000)),
          unit: "minute",
        },
        checkin_margin: 5,
        max_runtime: 10,
        timezone: "UTC",
      },
    },
    async () => {
      await runCanary({
        env,
        log: NOOP_LOG,
        errorLog: NOOP_LOG,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
    },
  );
}

/**
 * Wait one interval before the first canary. Each later timer is armed only
 * after the previous run settles, so a slow probe cannot overlap the next one.
 */
export function startDeliveryCanaryLoop(
  deps: DeliveryCanaryRunnerDeps,
): DeliveryCanaryRunnerHandle {
  const env = deps.env ?? process.env;
  const intervalMs = deps.intervalMs ?? deliveryCanaryIntervalMs(env);
  const setTimeoutImpl = deps.setTimeoutImpl
    ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
  const clearTimeoutImpl = deps.clearTimeoutImpl
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const errorLog = deps.errorLog ?? console.error;
  let stopped = false;
  let timer: unknown | null = null;
  let inFlight: Promise<void> | null = null;
  let activeController: AbortController | null = null;

  const arm = () => {
    if (stopped) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      void runOnce();
    }, intervalMs);
    if (
      timer !== null
      && typeof timer === "object"
      && "unref" in timer
      && typeof timer.unref === "function"
    ) {
      timer.unref();
    }
  };

  const runOnce = async (): Promise<void> => {
    if (stopped) return;
    const controller = new AbortController();
    activeController = controller;
    const running = (async () => {
      try {
        await runDeliveryCanaryTick({
          sentry: deps.sentry,
          env,
          intervalMs,
          signal: controller.signal,
          ...(deps.runCanary ? { runCanary: deps.runCanary } : {}),
        });
      } catch {
        if (!stopped) errorLog("[delivery-canary] check failed");
      }
    })();
    inFlight = running;
    try {
      await running;
    } finally {
      if (inFlight === running) inFlight = null;
      if (activeController === controller) activeController = null;
      arm();
    }
  };

  arm();

  return {
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      activeController?.abort();
      if (inFlight) await inFlight;
    },
  };
}
