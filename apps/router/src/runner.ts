/**
 * Periodic background job runner.
 *
 * Periodic router-side concerns (e.g. `processReplayBatch`, which drains
 * operator-initiated replays) don't fit the queue-driven hot path — without a
 * runner the functions exist but nothing schedules them. (Expired-row pruning
 * used to be listed here too; it now lives in delivery-service's retention
 * loop — see apps/delivery-service/src/retention.ts.) This module is a tiny
 * scheduler that:
 *   - kicks each registered job on its own interval
 *   - reports failures via the configured `AlertSink` (warn severity)
 *   - never overlaps a job with itself (skips a tick if the prior run is
 *     still in flight)
 *   - shuts down cleanly on `stop()` — waits for any in-flight job before
 *     resolving
 *
 * The runner does NOT use `worker_threads`; everything stays on the event
 * loop. Each job's run() is awaited fully, so a slow job slows itself but
 * cannot starve the others (they run on independent intervals).
 */

import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";
import type { AlertSink } from "./alerts.ts";
import { silentAlertSink } from "./alerts.ts";

export interface PeriodicJob {
  /** Short slug for log lines and alert details. */
  name: string;
  /**
   * How often to fire. The first run kicks off `intervalMs` after
   * `startPeriodicRunner` returns (i.e. there's no immediate run); set
   * `runOnStart: true` to flip that.
   */
  intervalMs: number;
  /** The async work to run. Errors are caught and reported, never re-thrown. */
  run: () => Promise<unknown>;
  /** If true, fire one run immediately (in addition to the interval cadence). */
  runOnStart?: boolean;
}

export interface RunnerOptions {
  alertSink?: AlertSink;
  /** Test injection point — defaults to `setInterval`. */
  setIntervalImpl?: (handler: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface RunnerHandle {
  /** Stop firing new ticks. Awaits any in-flight job before resolving. */
  stop(): Promise<void>;
  /** Snapshot of per-job stats (for tests / future health endpoint). */
  stats(): Record<string, JobStats>;
}

export interface JobStats {
  runs: number;
  failures: number;
  skipped: number;
  lastRunAt: string | null;
  lastDurationMs: number | null;
}

export function startPeriodicRunner(jobs: PeriodicJob[], options: RunnerOptions = {}): RunnerHandle {
  const alerts = options.alertSink ?? silentAlertSink();
  const setIntervalImpl = options.setIntervalImpl ?? ((h, ms) => setInterval(h, ms) as unknown);
  const clearIntervalImpl = options.clearIntervalImpl ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const setTimeoutImpl = options.setTimeoutImpl ?? ((h, ms) => setTimeout(h, ms) as unknown);
  const clearTimeoutImpl = options.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const handles = new Map<string, { interval: unknown; timeout?: unknown }>();
  const inFlight = new Map<string, Promise<void>>();
  const stats = new Map<string, JobStats>();
  let stopping = false;

  for (const job of jobs) {
    stats.set(job.name, {
      runs: 0,
      failures: 0,
      skipped: 0,
      lastRunAt: null,
      lastDurationMs: null,
    });

    const tick = async (): Promise<void> => {
      if (stopping) return;
      const current = inFlight.get(job.name);
      if (current) {
        // Previous run still in flight — skip this tick rather than overlap.
        const stat = stats.get(job.name)!;
        stat.skipped += 1;
        return;
      }

      const stat = stats.get(job.name)!;
      const startedAt = Date.now();
      const promise = (async () => {
        try {
          await job.run();
        } catch (err) {
          stat.failures += 1;
          const safeError = sanitizeConnectorDiagnosticForStorage(
            err instanceof Error ? err.message : String(err),
            500,
          );
          await alerts.notify({
            severity: "warn",
            rule: "periodic_job_failure",
            summary: `Periodic job ${job.name} failed: ${safeError}`,
            source: "router",
            details: {
              job: job.name,
              error: safeError,
            },
            occurred_at: new Date().toISOString(),
          });
        } finally {
          stat.runs += 1;
          stat.lastRunAt = new Date().toISOString();
          stat.lastDurationMs = Date.now() - startedAt;
        }
      })();

      inFlight.set(job.name, promise);
      try {
        await promise;
      } finally {
        inFlight.delete(job.name);
      }
    };

    const interval = setIntervalImpl(() => {
      void tick();
    }, job.intervalMs);

    const handleEntry: { interval: unknown; timeout?: unknown } = { interval };
    if (job.runOnStart) {
      handleEntry.timeout = setTimeoutImpl(() => {
        void tick();
      }, 0);
    }
    handles.set(job.name, handleEntry);
  }

  return {
    async stop() {
      stopping = true;
      for (const entry of handles.values()) {
        clearIntervalImpl(entry.interval);
        if (entry.timeout !== undefined) clearTimeoutImpl(entry.timeout);
      }
      handles.clear();
      // Wait for everything in flight before declaring shutdown complete.
      await Promise.allSettled(Array.from(inFlight.values()));
    },
    stats() {
      return Object.fromEntries(stats.entries());
    },
  };
}
