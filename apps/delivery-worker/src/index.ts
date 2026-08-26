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
  /** Renew active ownership this often while a connector is still working. */
  renewIntervalMs: number;
  begin(key: string): Promise<IdempotencyBeginResult>;
  renew(key: string, token: string): Promise<boolean> | boolean;
  complete(key: string, token: string, attempt: DeliveryAttempt): Promise<boolean> | boolean;
  fail(key: string, token: string, attempt: DeliveryAttempt): Promise<boolean> | boolean;
}

export type IdempotencyBeginResult =
  | { status: "started"; token: string }
  | { status: "duplicate" }
  | { status: "completed" };

/**
 * A second worker encountered a live claim for the same delivery. Callers
 * must retry the durable message later; treating this as success can ACK the
 * only remaining copy if the original process dies before completing.
 */
export class IdempotencyClaimInFlightError extends Error {
  constructor() {
    super("delivery idempotency claim is already in flight");
    this.name = "IdempotencyClaimInFlightError";
  }
}

/**
 * This worker no longer owns the claim it started with. The durable message
 * must be retried; a stale worker must not terminalize the replacement claim.
 */
export class IdempotencyClaimLostError extends Error {
  constructor(cause?: unknown) {
    super("delivery idempotency claim ownership was lost", { cause });
    this.name = "IdempotencyClaimLostError";
  }
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
  if (claim?.status === "completed") {
    const attempt = dedupedAttempt(message, "already_delivered");
    await deps.attempts.recordAttempt(attempt);
    return attempt;
  }
  if (claim?.status === "duplicate") {
    throw new IdempotencyClaimInFlightError();
  }

  const ownership =
    claim?.status === "started" && deps.idempotency
      ? startClaimRenewal(deps.idempotency, message.idempotency_key, claim.token)
      : null;

  try {
    return await processClaimedDelivery(deps, message, ownership);
  } finally {
    await ownership?.stop();
  }
}

async function processClaimedDelivery(
  deps: DeliveryWorkerDeps,
  message: DestinationQueueMessage,
  ownership: ClaimRenewal | null,
): Promise<DeliveryAttempt> {

  const destination = await deps.destinations.getDestination(
    message.workspace_id,
    message.destination_id,
  );

  if (!destination) {
    const attempt = terminalAttempt(message, "destination_not_found");
    await deps.attempts.recordAttempt(attempt);
    await settleClaim(deps.idempotency, ownership, "fail", message.idempotency_key, attempt);
    return attempt;
  }

  const connector = deps.connectors.get(destination.type);
  if (!connector) {
    const attempt = terminalAttempt(message, `connector_not_registered:${destination.type}`);
    await deps.attempts.recordAttempt(attempt);
    await settleClaim(deps.idempotency, ownership, "fail", message.idempotency_key, attempt);
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
        await settleClaim(deps.idempotency, ownership, "fail", message.idempotency_key, attempt);
        return attempt;
      }
      const attempt = breakerSkipAttempt(message, "retry", decision.reason);
      await deps.attempts.recordAttempt(attempt);
      await settleClaim(deps.idempotency, ownership, "fail", message.idempotency_key, attempt);
      await scheduleRetryIfAllowed(deps, message, attempt, decision.retry_after_ms);
      return attempt;
    }
    if (decision.decision === "skip_dead") {
      const attempt = breakerSkipAttempt(message, "dead", decision.reason);
      await deps.attempts.recordAttempt(attempt);
      await settleClaim(deps.idempotency, ownership, "fail", message.idempotency_key, attempt);
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
    await settleClaim(deps.idempotency, ownership, "complete", message.idempotency_key, attempt);
  } else {
    await settleClaim(deps.idempotency, ownership, "fail", message.idempotency_key, attempt);
    await scheduleRetryIfAllowed(deps, message, attempt);
  }
  return attempt;
}

interface ClaimRenewal {
  token: string;
  stop(): Promise<void>;
  assertHealthy(): void;
}

function startClaimRenewal(
  store: IdempotencyStore,
  key: string,
  token: string,
): ClaimRenewal {
  const intervalMs = positiveFiniteInteger(store.renewIntervalMs, "idempotency renewIntervalMs");
  let stopped = false;
  let pending: Promise<void> | null = null;
  let failure: unknown = null;
  const timer = setInterval(() => {
    if (stopped || pending || failure) return;
    pending = Promise.resolve()
      .then(() => store.renew(key, token))
      .then((renewed) => {
        if (!renewed) failure = new IdempotencyClaimLostError();
      })
      .catch((error: unknown) => {
        failure = new IdempotencyClaimLostError(error);
      })
      .finally(() => {
        pending = null;
      });
  }, intervalMs);

  return {
    token,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await pending;
    },
    assertHealthy() {
      if (failure) throw failure;
    },
  };
}

async function settleClaim(
  store: IdempotencyStore | undefined,
  ownership: ClaimRenewal | null,
  outcome: "complete" | "fail",
  key: string,
  attempt: DeliveryAttempt,
): Promise<void> {
  if (!store || !ownership) return;
  await ownership.stop();
  ownership.assertHealthy();
  const updated = await store[outcome](key, ownership.token, attempt);
  if (!updated) throw new IdempotencyClaimLostError();
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
  const owners = new Map<string, string>();
  let nextClaim = 0;
  return {
    states,
    renewIntervalMs: 60_000,
    async begin(key) {
      const state = states.get(key);
      if (state === "completed") return { status: "completed" };
      if (state === "in_flight") return { status: "duplicate" };
      const token = `memory-claim-${++nextClaim}`;
      states.set(key, "in_flight");
      owners.set(key, token);
      return { status: "started", token };
    },
    async renew(key, token) {
      return states.get(key) === "in_flight" && owners.get(key) === token;
    },
    async complete(key, token) {
      if (states.get(key) !== "in_flight" || owners.get(key) !== token) return false;
      states.set(key, "completed");
      owners.delete(key);
      return true;
    },
    async fail(key, token) {
      if (states.get(key) !== "in_flight" || owners.get(key) !== token) return false;
      states.set(key, "failed");
      owners.delete(key);
      return true;
    },
  };
}

function positiveFiniteInteger(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return Math.floor(value);
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
