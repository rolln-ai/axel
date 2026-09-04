import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { renderMetrics } from "../src/metrics.js";

describe("delivery metrics privacy", () => {
  it("exports only fixed label codes and aggregates collapsed values", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("GROUP BY circuit_state")) {
          return {
            rows: [
              { circuit_state: "closed", n: 2 },
              { circuit_state: "customer-private-state", n: 1 },
            ],
          };
        }
        if (sql.includes("FROM dead_letters")) {
          return {
            rows: [
              { reason: "HTTP 503: private-provider-body", n: 2 },
              { reason: "receiver echoed victim@example.test", n: 3 },
              { reason: "another private marker", n: 4 },
            ],
          };
        }
        if (sql.includes("FROM queue_quarantine")) {
          return {
            rows: [
              { failure_code: "missing_field", n: 2 },
              { failure_code: "customer-private-code", n: 1 },
            ],
          };
        }
        return { rows: [{ n: 0 }] };
      }),
    } as unknown as pg.Pool;

    const result = await renderMetrics(pool);

    expect(result.text).toContain(
      'axel_destinations_circuit_state{state="closed"} 2',
    );
    expect(result.text).toContain(
      'axel_destinations_circuit_state{state="unknown"} 1',
    );
    expect(result.text).toContain(
      'axel_dead_letters_24h{reason="http_error_503"} 2',
    );
    expect(result.text).toContain(
      'axel_dead_letters_24h{reason="operation_failed"} 7',
    );
    expect(result.text).toContain(
      'axel_queue_quarantine_24h{reason="missing_field"} 2',
    );
    expect(result.text).toContain(
      'axel_queue_quarantine_24h{reason="invalid_message"} 1',
    );
    expect(result.text).not.toContain("customer-private");
    expect(result.text).not.toContain("private-provider-body");
    expect(result.text).not.toContain("victim@example.test");
  });
});
