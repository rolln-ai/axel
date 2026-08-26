/**
 * Deployed queue-lag monitoring for the delivery queue.
 *
 * The audit flagged that the threshold evaluators in @axel/router were never
 * fed a live snapshot in production — `evaluateQueueLag` existed but nothing
 * called it on a running service. Rather than poll the (hard-to-verify)
 * Cloudflare Queues stats API, we derive lag from data already in hand: every
 * DestinationQueueMessage carries `enqueued_at`, so the age of the oldest
 * message in a pulled batch is a direct measure of how long work sat on the
 * delivery queue before this consumer reached it.
 *
 * The poll loop calls `observe()` once per batch. When the oldest age crosses
 * the configured threshold it emits via the AlertSink (alertSinkFromEnv —
 * a no-op unless ALERT_WEBHOOK_URL is set, so this is safe to wire
 * unconditionally). Emission is throttled per-process; with the delivery web
 * role scaled to N instances each instance may emit, so receiver-side
 * de-duplication is expected (see infra/alerts/README.md). `backlog` is a
 * lower bound (the batch size) — true backlog depth needs the CF stats API.
 */

import {
  evaluateQueueLag,
  type AlertSink,
  type AlertThresholds,
  type QueueLagSnapshot,
} from "@axel/router";

export interface QueueLagMonitorOptions {
  sink: AlertSink;
  thresholds?: AlertThresholds;
  /** Alert `source` slug. Default "delivery". */
  source?: string;
  /** Minimum ms between emitted alerts. Default 60s. */
  throttleMs?: number;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
}

export interface QueueLagMonitor {
  observe(messages: ReadonlyArray<{ enqueued_at?: string }>): Promise<void>;
}

export function createQueueLagMonitor(options: QueueLagMonitorOptions): QueueLagMonitor {
  const throttleMs = options.throttleMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const source = options.source ?? "delivery";
  let lastEmitAt = 0;

  async function observe(messages: ReadonlyArray<{ enqueued_at?: string }>): Promise<void> {
    if (messages.length === 0) return;
    const nowMs = now();
    let oldestSeconds = 0;
    for (const m of messages) {
      if (!m.enqueued_at) continue;
      const enq = Date.parse(m.enqueued_at);
      if (Number.isFinite(enq)) {
        oldestSeconds = Math.max(oldestSeconds, (nowMs - enq) / 1000);
      }
    }
    const snapshot: QueueLagSnapshot = {
      oldest_unacked_age_seconds: Math.round(oldestSeconds),
      backlog: messages.length,
    };
    const events = evaluateQueueLag(snapshot, options.thresholds, source);
    if (events.length === 0) return;
    if (nowMs - lastEmitAt < throttleMs) return;
    lastEmitAt = nowMs;
    for (const event of events) {
      await options.sink.notify(event);
    }
  }

  return { observe };
}
