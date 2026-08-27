import type { PulledMessageFailureCode } from "./pulled-message.js";

export class QueueConsumerMetrics {
  private pulledTotal = 0;
  private validV0Total = 0;
  private validV1Total = 0;
  private readonly invalidTotals = new Map<PulledMessageFailureCode, number>();
  private retryRequestedTotal = 0;
  private ackRequestedTotal = 0;
  private quarantineWriteFailuresTotal = 0;
  private ackApiFailuresTotal = 0;
  private lastInvalidAtSeconds = 0;

  recordPulled(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) this.pulledTotal += count;
  }

  recordValid(wireVersion: 0 | 1): void {
    if (wireVersion === 0) this.validV0Total += 1;
    else this.validV1Total += 1;
  }

  recordInvalid(code: PulledMessageFailureCode, nowMs = Date.now()): void {
    this.invalidTotals.set(code, (this.invalidTotals.get(code) ?? 0) + 1);
    this.lastInvalidAtSeconds = Math.floor(nowMs / 1_000);
  }

  recordDisposition(input: { acks: number; retries: number }): void {
    if (Number.isSafeInteger(input.acks) && input.acks > 0) this.ackRequestedTotal += input.acks;
    if (Number.isSafeInteger(input.retries) && input.retries > 0) this.retryRequestedTotal += input.retries;
  }

  recordQuarantineWriteFailure(): void {
    this.quarantineWriteFailuresTotal += 1;
  }

  recordAckApiFailure(): void {
    this.ackApiFailuresTotal += 1;
  }

  renderPrometheus(): string[] {
    const lines = [
      "# HELP axel_delivery_queue_pulled_total Cloudflare queue messages pulled by this process.",
      "# TYPE axel_delivery_queue_pulled_total counter",
      `axel_delivery_queue_pulled_total ${this.pulledTotal}`,
      "# HELP axel_delivery_queue_valid_total Queue messages that passed runtime validation.",
      "# TYPE axel_delivery_queue_valid_total counter",
      `axel_delivery_queue_valid_total{wire_version="0"} ${this.validV0Total}`,
      `axel_delivery_queue_valid_total{wire_version="1"} ${this.validV1Total}`,
      "# HELP axel_delivery_queue_invalid_total Queue messages rejected by runtime validation.",
      "# TYPE axel_delivery_queue_invalid_total counter",
    ];
    for (const [code, count] of [...this.invalidTotals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`axel_delivery_queue_invalid_total{reason="${code}"} ${count}`);
    }
    lines.push(
      "# HELP axel_delivery_queue_retry_requested_total Queue leases explicitly marked for retry.",
      "# TYPE axel_delivery_queue_retry_requested_total counter",
      `axel_delivery_queue_retry_requested_total ${this.retryRequestedTotal}`,
      "# HELP axel_delivery_queue_ack_requested_total Queue leases explicitly acknowledged.",
      "# TYPE axel_delivery_queue_ack_requested_total counter",
      `axel_delivery_queue_ack_requested_total ${this.ackRequestedTotal}`,
      "# HELP axel_delivery_queue_quarantine_write_failures_total Failed metadata quarantine writes.",
      "# TYPE axel_delivery_queue_quarantine_write_failures_total counter",
      `axel_delivery_queue_quarantine_write_failures_total ${this.quarantineWriteFailuresTotal}`,
      "# HELP axel_delivery_queue_ack_api_failures_total Failed or partial Cloudflare ack API calls.",
      "# TYPE axel_delivery_queue_ack_api_failures_total counter",
      `axel_delivery_queue_ack_api_failures_total ${this.ackApiFailuresTotal}`,
      "# HELP axel_delivery_queue_last_invalid_timestamp_seconds Unix timestamp of the latest rejected queue message.",
      "# TYPE axel_delivery_queue_last_invalid_timestamp_seconds gauge",
      `axel_delivery_queue_last_invalid_timestamp_seconds ${this.lastInvalidAtSeconds}`,
    );
    return lines;
  }
}
