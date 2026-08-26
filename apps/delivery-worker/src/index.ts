import type { Connector } from "@axel/connectors";
import {
  DEFAULT_RETRY_POLICY,
  type CircuitBreaker,
  type Destination,
  type DestinationQueueMessage,
  type DestinationType,
  type DeliveryAttempt,
  mapWithConcurrency,
  retryDelayMs,
  toArrayBuffer,
} from "@axel/shared";

export interface DestinationResolver {
  getDestination(workspaceId: string, destinationId: string): Promise<Destination | null>;
}

export interface AttemptLogSink {
  recordAttempt(attempt: DeliveryAttempt): Promise<void> | void;
}

export interface RetryQueueSink {
  scheduleRetry(message: DestinationQueueMessage): Promise<void> | void;
}

export interface IdempotencyStore {
  begin(key: string): Promise<"started" | "duplicate" | "completed">;
  complete(key: string, attempt: DeliveryAttempt): Promise<void> | void;
  fail(key: string, attempt: DeliveryAttempt): Promise<void> | void;
}

/**
 * AXE-27 — per-destination circuit breaker. The worker calls
 * `acquire()` before each attempt to decide whether to deliver,
 * skip-and-retry (open), or skip-and-dead-letter (disabled). After
 * the attempt it calls `recordOutcome()` so the breaker can advance
 * its state machine.
 *
 * The types (and the pure decision core, `evaluateBreaker`) moved to
 * @axel/shared so delivery-service and delivery-edge share one state
 * machine; re-exported here for compatibility. Implementations live
 * outside the worker (Postgres-backed in the delivery-service;
 * in-memory for tests). The worker stays pure.
 */
export type { CircuitBreaker, CircuitDecision } from "@axel/shared";

export interface DeliveryWorkerDeps {
  destinations: DestinationResolver;
  connectors: Map<DestinationType, Connector>;
  attempts: AttemptLogSink;
  retries?: RetryQueueSink;
  idempotency?: IdempotencyStore;
  /** AXE-27 — optional breaker. When unset, all attempts proceed. */
  circuitBreaker?: CircuitBreaker;
  now?: () => Date;
  random?: () => number;
  maxConcurrentMessages?: number;
}

export async function processDeliveryBatch(
  deps: DeliveryWorkerDeps,
  messages: DestinationQueueMessage[],
): Promise<DeliveryAttempt[]> {
  return mapWithConcurrency(
    messages,
    deps.maxConcurrentMessages ?? 64,
    (message) => processDeliveryMessage(deps, message),
  );
}

export async function processDeliveryMessage(
  deps: DeliveryWorkerDeps,
  message: DestinationQueueMessage,
): Promise<DeliveryAttempt> {
  const claim = await deps.idempotency?.begin(message.idempotency_key);
  if (claim === "completed") {
    const attempt = dedupedAttempt(message, "already_delivered");
    await deps.attempts.recordAttempt(attempt);
    return attempt;
  }
  if (claim === "duplicate") {
    // A copy of this exact (workspace, event, route, destination) is already
    // in-flight. That in-flight attempt is the canonical delivery — it will
    // complete or retry on its own — so suppressing this duplicate is correct
    // dedup, NOT a failure. Record it as a benign deduped success (same as the
    // `completed` branch above) rather than a dead-letter, so it never clutters
    // the failure inbox.
    const attempt = dedupedAttempt(message, "duplicate_in_flight");
    await deps.attempts.recordAttempt(attempt);
    return attempt;
  }

  const destination = await deps.destinations.getDestination(
    message.workspace_id,
    message.destination_id,
  );

  if (!destination) {
    const attempt = terminalAttempt(message, "destination_not_found");
    await deps.attempts.recordAttempt(attempt);
    await deps.idempotency?.fail(message.idempotency_key, attempt);
    return attempt;
  }

  const connector = deps.connectors.get(destination.type);
  if (!connector) {
    const attempt = terminalAttempt(message, `connector_not_registered:${destination.type}`);
    await deps.attempts.recordAttempt(attempt);
    await deps.idempotency?.fail(message.idempotency_key, attempt);
    return attempt;
  }

  // AXE-27 — check the breaker before opening a connection. An open
  // breaker turns the attempt into a synthetic "retry" so the queue
  // re-delivers after the cooldown; a "disabled" breaker dead-letters
  // it so the operator's pause-now action drains the backlog instead
  // of growing it.
  if (deps.circuitBreaker) {
    const decision = await deps.circuitBreaker.acquire({
      workspaceId: message.workspace_id,
      destinationId: message.destination_id,
    });
    if (decision.decision === "skip_retry") {
      // A skip on the FINAL attempt must terminalize to "dead". Left as
      // "retry", scheduleRetryIfAllowed re-enqueues nothing, the lease is
      // acked, and the event vanishes with no dead_letters row — a long
      // pause silently dropped everything that exhausted its budget.
      if (message.attempt_no >= message.max_attempts) {
        const attempt = breakerSkipAttempt(message, "dead", decision.reason, {
          error: "max_attempts_exhausted",
          final_attempt_no: message.attempt_no,
        });
        await deps.attempts.recordAttempt(attempt);
        await deps.idempotency?.fail(message.idempotency_key, attempt);
        return attempt;
      }
      const attempt = breakerSkipAttempt(message, "retry", decision.reason);
      await deps.attempts.recordAttempt(attempt);
      await deps.idempotency?.fail(message.idempotency_key, attempt);
      await scheduleRetryIfAllowed(deps, message, attempt, decision.retry_after_ms);
      return attempt;
    }
    if (decision.decision === "skip_dead") {
      const attempt = breakerSkipAttempt(message, "dead", decision.reason);
      await deps.attempts.recordAttempt(attempt);
      await deps.idempotency?.fail(message.idempotency_key, attempt);
      return attempt;
    }
  }

  let attempt = await connector.deliver(encodePayload(message.payload), destination, {
    eventId: message.event_id,
    workspaceId: message.workspace_id,
    sourceId: message.source_id,
    routeId: message.route_id,
    receivedAt: message.received_at,
    isTest: message.is_test,
    binding: message.binding ?? null,
  });
  // Exhausted-retry terminalization: a connector "retry" on the FINAL attempt
  // would otherwise loop forever — scheduleRetryIfAllowed re-enqueues nothing,
  // the queue lease is released, and CF redelivers the same attempt_no. Convert
  // it to a terminal "dead" so the event dead-letters instead of looping.
  if (attempt.status === "retry" && message.attempt_no >= message.max_attempts) {
    attempt = {
      ...attempt,
      status: "dead",
      response: {
        ...(attempt.response && typeof attempt.response === "object" ? attempt.response : {}),
        error: "max_attempts_exhausted",
        final_attempt_no: message.attempt_no,
      },
    };
  }
  await deps.attempts.recordAttempt(attempt);
  if (deps.circuitBreaker) {
    await deps.circuitBreaker.recordOutcome({
      workspaceId: message.workspace_id,
      destinationId: message.destination_id,
      status: attempt.status,
      attempt,
    });
  }
  if (attempt.status === "success") {
    await deps.idempotency?.complete(message.idempotency_key, attempt);
  } else {
    await deps.idempotency?.fail(message.idempotency_key, attempt);
    await scheduleRetryIfAllowed(deps, message, attempt);
  }
  return attempt;
}

function breakerSkipAttempt(
  message: DestinationQueueMessage,
  status: "retry" | "dead",
  reason: string,
  extra?: Record<string, unknown>,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: message.event_id,
    destination_id: message.destination_id,
    status,
    response: { skipped_by: "circuit_breaker", reason, ...extra },
    latency_ms: 0,
    created_at: new Date().toISOString(),
  };
}

export function createInMemoryDeliveryDeps(input: {
  destinations: Destination[];
  connectors: Map<DestinationType, Connector>;
}): DeliveryWorkerDeps & { attemptsLog: DeliveryAttempt[]; retryLog: DestinationQueueMessage[] } {
  const destinations = new Map(
    input.destinations.map((destination) => [
      keyFor(destination.workspace_id, destination.destination_id),
      destination,
    ]),
  );
  const attemptsLog: DeliveryAttempt[] = [];
  const retryLog: DestinationQueueMessage[] = [];
  return {
    connectors: input.connectors,
    attemptsLog,
    retryLog,
    destinations: {
      async getDestination(workspaceId, destinationId) {
        return destinations.get(keyFor(workspaceId, destinationId)) ?? null;
      },
    },
    attempts: {
      recordAttempt(attempt) {
        attemptsLog.push(attempt);
      },
    },
    retries: {
      scheduleRetry(message) {
        retryLog.push(message);
      },
    },
    idempotency: createInMemoryIdempotencyStore(),
  };
}

export function createInMemoryIdempotencyStore(): IdempotencyStore & {
  states: Map<string, "in_flight" | "completed" | "failed">;
} {
  const states = new Map<string, "in_flight" | "completed" | "failed">();
  return {
    states,
    async begin(key) {
      const state = states.get(key);
      if (state === "completed") return "completed";
      if (state === "in_flight") return "duplicate";
      states.set(key, "in_flight");
      return "started";
    },
    async complete(key) {
      states.set(key, "completed");
    },
    async fail(key) {
      states.set(key, "failed");
    },
  };
}

function encodePayload(payload: unknown): ArrayBuffer {
  if (payload instanceof ArrayBuffer) return payload;
  return toArrayBuffer(new TextEncoder().encode(JSON.stringify(payload)));
}

function terminalAttempt(
  message: DestinationQueueMessage,
  error: string,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: message.event_id,
    destination_id: message.destination_id,
    status: "dead",
    response: { error },
    latency_ms: 0,
    created_at: new Date().toISOString(),
  };
}

function dedupedAttempt(
  message: DestinationQueueMessage,
  reason: string,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: message.event_id,
    destination_id: message.destination_id,
    status: "success",
    response: { deduped: true, reason },
    latency_ms: 0,
    created_at: new Date().toISOString(),
  };
}

async function scheduleRetryIfAllowed(
  deps: DeliveryWorkerDeps,
  message: DestinationQueueMessage,
  attempt: DeliveryAttempt,
  minDelayMs?: number,
): Promise<void> {
  if (attempt.status !== "retry") return;
  if (message.attempt_no >= message.max_attempts) return;
  if (!deps.retries) return;

  const now = deps.now ?? (() => new Date());
  const delay = Math.max(
    retryDelayMs(message.attempt_no, DEFAULT_RETRY_POLICY, deps.random),
    minDelayMs ?? 0,
  );
  const nextAttemptAt = new Date(now().getTime() + delay).toISOString();
  await deps.retries.scheduleRetry({
    ...message,
    attempt_no: message.attempt_no + 1,
    next_attempt_at: nextAttemptAt,
  });
}

function keyFor(workspaceId: string, destinationId: string): string {
  return `${workspaceId}:${destinationId}`;
}
