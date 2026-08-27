import { describe, expect, it } from "vitest";
import { QueueConsumerMetrics } from "../src/queue-consumer-metrics.ts";

describe("QueueConsumerMetrics", () => {
  it("renders bounded counters without message ids or payload data", () => {
    const metrics = new QueueConsumerMetrics();
    metrics.recordPulled(3);
    metrics.recordValid(0);
    metrics.recordValid(1);
    metrics.recordInvalid("missing_field", 1_780_000_000_000);
    metrics.recordDisposition({ acks: 1, retries: 2 });
    metrics.recordQuarantineWriteFailure();
    metrics.recordAckApiFailure();

    const output = metrics.renderPrometheus().join("\n");
    expect(output).toContain("axel_delivery_queue_pulled_total 3");
    expect(output).toContain('axel_delivery_queue_valid_total{wire_version="0"} 1');
    expect(output).toContain('axel_delivery_queue_valid_total{wire_version="1"} 1');
    expect(output).toContain('axel_delivery_queue_invalid_total{reason="missing_field"} 1');
    expect(output).toContain("axel_delivery_queue_retry_requested_total 2");
    expect(output).toContain("axel_delivery_queue_ack_requested_total 1");
    expect(output).toContain("axel_delivery_queue_last_invalid_timestamp_seconds 1780000000");
  });
});
