/**
 * Deployed queue-lag monitoring for the delivery queue.
 *
 * The monitor consumes both Cloudflare's realtime Queue metrics and timestamps
 * from pulled messages. The API snapshot detects a growing backlog even when
 * no message is successfully leased; the pulled-message path is retained as a
 * second signal during provider metric gaps.
 *
 * When the oldest age crosses the configured threshold it emits through the
 * combined Sentry/operator AlertSink. Emission is throttled per process; with
 * the delivery web role scaled to N instances each instance may emit, so
 * receiver-side de-duplication is expected (see infra/alerts/README.md).
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
  observeSnapshot(snapshot: QueueLagSnapshot): Promise<void>;
}

export function createQueueLagMonitor(options: QueueLagMonitorOptions): QueueLagMonitor {
  const throttleMs = options.throttleMs ?? 60_000;
  const now = options.now ?? (() => Date.now());
  const source = options.source ?? "delivery";
  let lastEmitAt = 0;

  async function observeSnapshot(snapshot: QueueLagSnapshot): Promise<void> {
    const nowMs = now();
    const events = evaluateQueueLag(snapshot, options.thresholds, source);
    if (events.length === 0) return;
    if (nowMs - lastEmitAt < throttleMs) return;
    lastEmitAt = nowMs;
    for (const event of events) {
      await options.sink.notify(event);
    }
  }

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
    await observeSnapshot(snapshot);
  }

  return { observe, observeSnapshot };
}
