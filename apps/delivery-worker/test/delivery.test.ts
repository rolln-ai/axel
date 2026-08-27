import { describe, expect, it, vi } from "vitest";
import { createConnectorRegistry, type Connector } from "@axel/connectors";
import type { DeliveryAttempt, Destination, DestinationQueueMessage } from "@axel/shared";
import {
  createInMemoryDeliveryDeps,
  IdempotencyClaimInFlightError,
  IdempotencyClaimLostError,
  processDeliveryBatch,
  processDeliveryMessage,
  type CircuitBreaker,
  type CircuitDecision,
  type IdempotencyStore,
} from "../src/index.ts";

describe("delivery worker", () => {
  it("resolves the destination, runs the registered connector, and records the attempt", async () => {
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        return attempt(context?.eventId ?? "missing", destination.destination_id, "success");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });

    const out = await processDeliveryMessage(deps, message());

    expect(out.status).toBe("success");
    expect(out.event_id).toBe("evt-1");
    expect(deps.attemptsLog).toEqual([out]);
  });

  it("records a terminal attempt when the destination is missing", async () => {
    const deps = createInMemoryDeliveryDeps({
      destinations: [],
      connectors: createConnectorRegistry([]),
    });

    const out = await processDeliveryMessage(deps, message());

    expect(out.status).toBe("dead");
    expect(out.response).toEqual({ error: "destination_not_found" });
    expect(deps.attemptsLog).toHaveLength(1);
  });

  it("schedules bounded retries for retryable connector attempts", async () => {
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        return attempt(context?.eventId ?? "missing", destination.destination_id, "retry");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });
    deps.now = () => new Date("2026-05-02T12:00:02.000Z");
    deps.random = () => 0;

    const out = await processDeliveryMessage(deps, message());

    expect(out.status).toBe("retry");
    expect(deps.retryLog).toHaveLength(1);
    expect(deps.retryLog[0]?.attempt_no).toBe(2);
    expect(deps.retryLog[0]?.next_attempt_at).toBe("2026-05-02T12:00:03.000Z");
  });

  it("terminalizes an exhausted retry to dead instead of looping forever", async () => {
    // Audit fix: a connector "retry" on the final attempt (attempt_no >=
    // max_attempts) used to leave status "retry" with no re-enqueue, so the
    // queue released the lease and CF redelivered the same attempt_no forever.
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, dest, ctx) {
        return attempt(ctx?.eventId ?? "missing", dest.destination_id, "retry");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });

    const exhausted: DestinationQueueMessage = { ...message(), attempt_no: 12, max_attempts: 12 };
    const out = await processDeliveryMessage(deps, exhausted);

    expect(out.status).toBe("dead");
    expect(out.response).toMatchObject({ error: "max_attempts_exhausted", final_attempt_no: 12 });
    expect(deps.retryLog).toHaveLength(0);
  });

  it("keeps duplicate in-flight deliveries retryable instead of reporting success", async () => {
    let calls = 0;
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        calls += 1;
        return attempt(context?.eventId ?? "missing", destination.destination_id, "success");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });
    await deps.idempotency?.begin("ws-1:evt-1:rt-1:dest-1");

    const delivery = processDeliveryMessage(deps, message());

    // The original process can crash after claiming. Returning a synthetic
    // success here would let the redelivery ACK the only durable copy before
    // the stale claim can be reclaimed.
    await expect(delivery).rejects.toBeInstanceOf(IdempotencyClaimInFlightError);
    expect(calls).toBe(0);
    expect(deps.attemptsLog).toHaveLength(0);
  });

  it("treats completed duplicate deliveries as deduped success", async () => {
    let calls = 0;
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        calls += 1;
        return attempt(context?.eventId ?? "missing", destination.destination_id, "success");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });

    const first = await processDeliveryMessage(deps, message());
    const duplicate = await processDeliveryMessage(deps, message());

    expect(first.status).toBe("success");
    expect(calls).toBe(1);
    expect(duplicate.status).toBe("success");
    expect(duplicate.response).toEqual({ deduped: true, reason: "already_delivered" });
    expect(deps.attemptsLog).toHaveLength(2);
  });

  it("carries the opaque claim token through completion", async () => {
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        return attempt(context?.eventId ?? "missing", destination.destination_id, "success");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    deps.idempotency = {
      renewIntervalMs: 60_000,
      begin: async () => ({ status: "started", token: "owner-opaque" }),
      renew: async () => true,
      complete,
      fail,
    };

    const out = await processDeliveryMessage(deps, message());

    expect(complete).toHaveBeenCalledWith(
      "ws-1:evt-1:rt-1:dest-1",
      "owner-opaque",
      out,
    );
    expect(fail).not.toHaveBeenCalled();
  });

  it("carries the opaque claim token through failure", async () => {
    const deps = createInMemoryDeliveryDeps({
      destinations: [],
      connectors: createConnectorRegistry([]),
    });
    const complete = vi.fn(async () => true);
    const fail = vi.fn(async () => true);
    deps.idempotency = {
      renewIntervalMs: 60_000,
      begin: async () => ({ status: "started", token: "owner-opaque" }),
      renew: async () => true,
      complete,
      fail,
    };

    const out = await processDeliveryMessage(deps, message());

    expect(fail).toHaveBeenCalledWith(
      "ws-1:evt-1:rt-1:dest-1",
      "owner-opaque",
      out,
    );
    expect(complete).not.toHaveBeenCalled();
  });

  it("renews ownership while a connector delivery is still buffered", async () => {
    vi.useFakeTimers();
    try {
      let releaseConnector: ((value: DeliveryAttempt) => void) | undefined;
      let reportStarted: (() => void) | undefined;
      const connectorStarted = new Promise<void>((resolve) => {
        reportStarted = resolve;
      });
      const connector: Connector<{ ok: true }> = {
        type: "http",
        deliver() {
          reportStarted?.();
          return new Promise<DeliveryAttempt>((resolve) => {
            releaseConnector = resolve;
          });
        },
      };
      const deps = createInMemoryDeliveryDeps({
        destinations: [destination()],
        connectors: createConnectorRegistry([connector]),
      });
      const renew = vi.fn(async () => true);
      const complete = vi.fn(async () => true);
      deps.idempotency = {
        renewIntervalMs: 100,
        begin: async () => ({ status: "started", token: "owner-buffered" }),
        renew,
        complete,
        fail: async () => true,
      } satisfies IdempotencyStore;

      const processing = processDeliveryMessage(deps, message());
      await connectorStarted;
      await vi.advanceTimersByTimeAsync(100);

      expect(renew).toHaveBeenCalledWith("ws-1:evt-1:rt-1:dest-1", "owner-buffered");
      releaseConnector?.(attempt("evt-1", "dest-1", "success"));
      await expect(processing).resolves.toMatchObject({ status: "success" });
      expect(complete).toHaveBeenCalledWith(
        "ws-1:evt-1:rt-1:dest-1",
        "owner-buffered",
        expect.objectContaining({ status: "success" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to settle after renewal reports that another worker owns the claim", async () => {
    vi.useFakeTimers();
    try {
      let releaseConnector: ((value: DeliveryAttempt) => void) | undefined;
      const connector: Connector<{ ok: true }> = {
        type: "http",
        deliver() {
          return new Promise<DeliveryAttempt>((resolve) => {
            releaseConnector = resolve;
          });
        },
      };
      const deps = createInMemoryDeliveryDeps({
        destinations: [destination()],
        connectors: createConnectorRegistry([connector]),
      });
      const complete = vi.fn(async () => true);
      deps.idempotency = {
        renewIntervalMs: 100,
        begin: async () => ({ status: "started", token: "owner-stale" }),
        renew: async () => false,
        complete,
        fail: async () => false,
      } satisfies IdempotencyStore;

      const processing = processDeliveryMessage(deps, message());
      await vi.advanceTimersByTimeAsync(100);
      releaseConnector?.(attempt("evt-1", "dest-1", "success"));

      await expect(processing).rejects.toBeInstanceOf(IdempotencyClaimLostError);
      expect(complete).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries when fenced completion reports that ownership was lost", async () => {
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        return attempt(context?.eventId ?? "missing", destination.destination_id, "success");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });
    deps.idempotency = {
      renewIntervalMs: 60_000,
      begin: async () => ({ status: "started", token: "owner-stale" }),
      renew: async () => true,
      complete: async () => false,
      fail: async () => false,
    };

    await expect(processDeliveryMessage(deps, message())).rejects.toBeInstanceOf(
      IdempotencyClaimLostError,
    );
  });

  it("processes batches with bounded concurrency", async () => {
    const connector: Connector<{ ok: true }> = {
      type: "http",
      async deliver(_event, destination, context) {
        return attempt(context?.eventId ?? "missing", destination.destination_id, "success");
      },
    };
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([connector]),
    });

    const out = await processDeliveryBatch(deps, [message("evt-1"), message("evt-2")]);

    expect(out.map((attempt) => attempt.event_id)).toEqual(["evt-1", "evt-2"]);
    expect(deps.attemptsLog).toHaveLength(2);
  });
});

describe("circuit breaker (AXE-27)", () => {
  const okConnector: Connector<{ ok: true }> = {
    type: "http",
    async deliver(_event, dest, ctx) {
      return attempt(ctx?.eventId ?? "missing", dest.destination_id, "success");
    },
  };
  const failConnector: Connector<{ ok: true }> = {
    type: "http",
    async deliver(_event, dest, ctx) {
      return attempt(ctx?.eventId ?? "missing", dest.destination_id, "retry");
    },
  };

  function inMemoryBreaker(initial: CircuitDecision = { decision: "deliver" }): CircuitBreaker & {
    decisions: CircuitDecision[];
    outcomes: string[];
    setDecision(d: CircuitDecision): void;
  } {
    let current = initial;
    const decisions: CircuitDecision[] = [];
    const outcomes: string[] = [];
    return {
      decisions,
      outcomes,
      setDecision(d) {
        current = d;
      },
      async acquire() {
        decisions.push(current);
        return current;
      },
      async recordOutcome({ status }) {
        outcomes.push(status);
      },
    };
  }

  it("short-circuits as a retry when the breaker is in cooldown", async () => {
    let calls = 0;
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([{
        type: "http" as const,
        async deliver(_event, dest, ctx) {
          calls += 1;
          return attempt(ctx?.eventId ?? "missing", dest.destination_id, "success");
        },
      }]),
    });
    deps.circuitBreaker = inMemoryBreaker({ decision: "skip_retry", reason: "breaker_open_cooldown_active" });

    const out = await processDeliveryMessage(deps, message());

    expect(calls).toBe(0);
    expect(out.status).toBe("retry");
    expect(out.response).toMatchObject({ skipped_by: "circuit_breaker" });
    expect(deps.retryLog).toHaveLength(1);
    expect(deps.retryLog[0]?.attempt_no).toBe(2);
  });

  it("dead-letters when the breaker is manually disabled", async () => {
    let calls = 0;
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([{
        type: "http" as const,
        async deliver(_event, dest, ctx) {
          calls += 1;
          return attempt(ctx?.eventId ?? "missing", dest.destination_id, "success");
        },
      }]),
    });
    deps.circuitBreaker = inMemoryBreaker({ decision: "skip_dead", reason: "destination_disabled_manually" });

    const out = await processDeliveryMessage(deps, message());

    expect(calls).toBe(0);
    expect(out.status).toBe("dead");
    expect(deps.retryLog).toHaveLength(0);
  });

  it("terminalizes a breaker skip on the final attempt so it dead-letters", async () => {
    let calls = 0;
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([{
        type: "http" as const,
        async deliver(_event, dest, ctx) {
          calls += 1;
          return attempt(ctx?.eventId ?? "missing", dest.destination_id, "success");
        },
      }]),
    });
    deps.circuitBreaker = inMemoryBreaker({ decision: "skip_retry", reason: "delivery_paused" });

    const out = await processDeliveryMessage(deps, { ...message(), attempt_no: 12 });

    expect(calls).toBe(0);
    expect(out.status).toBe("dead");
    expect(out.response).toMatchObject({
      skipped_by: "circuit_breaker",
      reason: "delivery_paused",
      error: "max_attempts_exhausted",
      final_attempt_no: 12,
    });
    expect(deps.retryLog).toHaveLength(0);
  });

  it("floors the skip retry delay at the breaker's retry_after_ms hint", async () => {
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([okConnector]),
    });
    deps.circuitBreaker = inMemoryBreaker({
      decision: "skip_retry",
      reason: "breaker_open_cooldown_active",
      retry_after_ms: 300_000,
    });
    const now = new Date("2026-05-02T12:00:05.000Z");
    deps.now = () => now;

    const out = await processDeliveryMessage(deps, message());

    expect(out.status).toBe("retry");
    expect(deps.retryLog).toHaveLength(1);
    const next = Date.parse(deps.retryLog[0]?.next_attempt_at ?? "");
    // attempt_no 1's normal backoff is ~1s; the hint must win.
    expect(next - now.getTime()).toBeGreaterThanOrEqual(300_000);
  });

  it("records the outcome status after a real attempt", async () => {
    const breaker = inMemoryBreaker();
    const deps = createInMemoryDeliveryDeps({
      destinations: [destination()],
      connectors: createConnectorRegistry([failConnector]),
    });
    deps.circuitBreaker = breaker;

    await processDeliveryMessage(deps, message());

    expect(breaker.outcomes).toEqual(["retry"]);
  });
});

function destination(): Destination<{ ok: true }> {
  return {
    destination_id: "dest-1",
    workspace_id: "ws-1",
    type: "http",
    config: { ok: true },
    credentials_ref: "cred-1",
  };
}

function message(eventId = "evt-1"): DestinationQueueMessage {
  return {
    queue_message_version: 1,
    event_id: eventId,
    workspace_id: "ws-1",
    source_id: "src-1",
    route_id: "rt-1",
    destination_id: "dest-1",
    r2_key: "events/ws-1/evt-1",
    received_at: "2026-05-02T12:00:00.000Z",
    enqueued_at: "2026-05-02T12:00:01.000Z",
    attempt_no: 1,
    max_attempts: 12,
    idempotency_key: `ws-1:${eventId}:rt-1:dest-1`,
    content_type: "application/json",
    size_bytes: 10,
    payload: { hello: "world" },
    headers: {},
    query: {},
    is_test: false,
  };
}

function attempt(
  eventId: string,
  destinationId: string,
  status: DeliveryAttempt["status"],
): DeliveryAttempt {
  return {
    attempt_id: "att-1",
    event_id: eventId,
    destination_id: destinationId,
    status,
    response: {},
    latency_ms: 1,
    created_at: "2026-05-02T12:00:02.000Z",
  };
}
