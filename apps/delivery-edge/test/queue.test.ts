import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deadLetterFingerprint,
  sanitizeConnectorDiagnosticForStorage,
  type DestinationQueueMessage,
  type DestinationType,
} from "@axel/shared";

const sqlState = vi.hoisted(() => ({
  destinations: [] as Array<{
    id: string;
    workspace_id: string;
    type: DestinationType;
    config: unknown;
    credentials_ref: string | null;
  }>,
  deadLetters: [] as unknown[],
  failDeadLetterInsert: false,
  // Null auto-generates a successful fresh claim using the candidate token.
  // Explicit rows exercise completed or competing-owner decisions.
  idempotency: null as null | Array<{
    state: string;
    claimed: boolean;
    claim_token: string | null;
    claim_expires_at?: string;
  }>,
  idempotencyRenew: [{ updated: true }] as Array<{ updated: boolean }>,
  idempotencySettle: [{ updated: true }] as Array<{ updated: boolean }>,
  // Canned response for the breaker failure-bump UPDATE...RETURNING. Set a row
  // with consecutive >= threshold to exercise the auto-trip path.
  breakerBump: [] as Array<{
    circuit_state: string;
    circuit_consecutive_failures: number;
    circuit_threshold_failures: number;
  }>,
  // Canned response for the open→half_open probe-claim UPDATE...RETURNING id
  // (shared breaker core). Non-empty = this worker won the probe slot and
  // delivers; empty = another worker beat it and the message retries.
  breakerFlip: [{ id: "dest-1" }] as Array<{ id: string }>,
  // Every executed query, joined with "?" placeholders — lets tests assert the
  // breaker trip/reset UPDATEs fired.
  queries: [] as string[],
  unsafeQueries: [] as Array<{ query: string; parameters: unknown[] }>,
  end: vi.fn(),
}));

const logDeliveryAttemptMock = vi.hoisted(() => vi.fn());

vi.mock("postgres", () => ({
  default: vi.fn(() => {
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      sqlState.queries.push(query);
      if (query.includes("FROM destinations")) return sqlState.destinations;
      if (query.includes("circuit_consecutive_failures = circuit_consecutive_failures + 1")) return sqlState.breakerBump;
      if (query.includes("circuit_state = 'half_open'") && query.includes("RETURNING id")) return sqlState.breakerFlip;
      if (query.includes("INSERT INTO dead_letters")) {
        if (sqlState.failDeadLetterInsert) throw new Error("postgres unavailable");
        sqlState.deadLetters.push(values);
        return [];
      }
      return [];
    }) as unknown as SqlMock;
    sql.unsafe = vi.fn(async (query: string, parameters: unknown[] = []) => {
      sqlState.queries.push(query);
      sqlState.unsafeQueries.push({ query, parameters });
      if (query.includes("WITH claimed AS")) {
        if (sqlState.idempotency) return sqlState.idempotency;
        const token = parameters[6] as string;
        return [{
          state: "in_flight",
          claimed: true,
          claim_token: token,
          claim_expires_at: new Date(Date.now() + 360_000).toISOString(),
        }];
      }
      if (query.includes("SET state = $3::text")) return sqlState.idempotencySettle;
      if (query.includes("expires_at = now() + ($3::bigint")) return sqlState.idempotencyRenew;
      return [];
    });
    sql.end = sqlState.end;
    sql.json = (value: unknown) => value;
    return sql;
  }),
}));

vi.mock("../src/clickhouse-log.js", () => ({
  logDeliveryAttempt: logDeliveryAttemptMock,
}));

import worker from "../src/index.ts";

describe("delivery-edge queue handler", () => {
  beforeEach(() => {
    sqlState.destinations = [];
    sqlState.deadLetters = [];
    sqlState.idempotency = null;
    sqlState.idempotencyRenew = [{ updated: true }];
    sqlState.idempotencySettle = [{ updated: true }];
    sqlState.breakerBump = [];
    sqlState.breakerFlip = [{ id: "dest-1" }];
    sqlState.queries = [];
    sqlState.unsafeQueries = [];
    sqlState.failDeadLetterInsert = false;
    sqlState.end.mockReset();
    sqlState.end.mockResolvedValue(undefined);
    logDeliveryAttemptMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports a scheduled heartbeat even when the delivery queue is idle", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => pending.push(promise)),
      passThroughOnException: vi.fn(),
      props: {},
    } as unknown as ExecutionContext;

    await worker.scheduled(
      {} as ScheduledController,
      env({
        DELIVERY_SERVICE_URL: "https://delivery.example/",
        DELIVERY_SHARED_SECRET: "shared",
      }),
      ctx,
    );
    await Promise.all(pending);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://delivery.example/internal/heartbeat",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-axel-shared-secret": "shared" }),
      }),
    );
  });

  it("acks successful HTTP deliveries and logs the attempt asynchronously", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();
    const ctx = executionContext();

    await worker.queue(batch("axel-delivery", [message]), env(), ctx);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://receiver.example",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
    );
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event_id: "evt-1",
      destination_id: "dest-1",
      status: "success",
      response: { destination_type: "http", http_status: 204 },
    }));
    expect(ctx.waitUntil).toHaveBeenCalled();
  });

  it("binds credential lookup to the destination and workspace", async () => {
    sqlState.destinations = [{
      ...destination("http", { url: "https://receiver.example" }),
      credentials_ref: "cred-other-workspace",
    }];
    const message = queueMessage();

    await worker.queue(
      batch("axel-delivery", [message]),
      env({ CREDENTIALS_MASTER_KEY: "00".repeat(32) }),
      executionContext(),
    );

    const credentialQuery = sqlState.queries.find((query) =>
      query.includes("FROM destination_credentials")
    );
    expect(credentialQuery).toContain("WHERE id = ?");
    expect(credentialQuery).toContain("AND workspace_id = ?");
    expect(credentialQuery).toContain("AND destination_id = ?");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("retries transient HTTP delivery failures", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "retry",
      response: { destination_type: "http", http_status: 503 },
    }));
  });

  it("acks terminal delivery failures so they do not retry forever", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "dead",
      response: { destination_type: "http", http_status: 404 },
    }));
    // Theme B (b2): a terminal "dead" outcome writes a dead_letters row so it's
    // visible + replayable (was silently ACKed with no row before).
    expect(sqlState.deadLetters.length).toBe(1);
  });

  it("skips a delivery whose idempotency claim is already completed (no double-deliver)", async () => {
    // Theme B (b1): CF redelivery of an already-completed delivery must NOT
    // re-POST. The claim query reports a prior completion.
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    sqlState.idempotency = [{ state: "completed", claimed: false, claim_token: "att-old" }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(fetchSpy).not.toHaveBeenCalled(); // no second POST to the receiver
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries without sending when a native worker owns a live claim", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    sqlState.idempotency = [{
      state: "in_flight",
      claimed: false,
      claim_token: "claim_native-owner",
      claim_expires_at: new Date(Date.now() + 360_000).toISOString(),
    }];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith(expect.objectContaining({
      delaySeconds: expect.any(Number),
    }));
    expect(sqlState.unsafeQueries.some(({ query }) => query.includes("SET state = $3::text"))).toBe(false);
  });

  it("uses the same opaque token to claim and settle, with a state-and-owner fence", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    const claimQuery = sqlState.unsafeQueries.find(({ query }) => query.includes("WITH claimed AS"));
    const settleQuery = sqlState.unsafeQueries.find(({ query }) => query.includes("SET state = $3::text"));
    const token = claimQuery?.parameters[6];
    expect(token).toEqual(expect.stringMatching(/^claim_[0-9a-f-]+$/));
    expect(settleQuery?.parameters).toEqual([
      "ws-1:evt-1:rt-1:dest-1",
      token,
      "completed",
      "evt-1-dest-1-1",
    ]);
    expect(settleQuery?.query).toContain("AND state = 'in_flight'");
    expect(settleQuery?.query).toContain("AND attempt_id = $2");
    expect(claimQuery?.query).toContain("delivery_idempotency.expires_at <= now()");
  });

  it("retries the durable message when fenced settlement reports lost ownership", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    sqlState.idempotencySettle = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
  });

  it("renews ownership while an edge object-store write remains active", async () => {
    vi.useFakeTimers();
    try {
      sqlState.destinations = [destination("r2", { bucket: "events" })];
      let finishPut: (() => void) | undefined;
      const put = vi.fn(() => new Promise<void>((resolve) => {
        finishPut = resolve;
      }));
      const message = queueMessage();
      const processing = worker.queue(
        batch("axel-delivery", [message]),
        env({ EVENTS_RAW: { put }, IDEMPOTENCY_CLAIM_LEASE_MS: "60000" }),
        executionContext(),
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(put).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(20_000);

      const renewQuery = sqlState.unsafeQueries.find(({ query }) =>
        query.includes("expires_at = now() + ($3::bigint")
      );
      const claimQuery = sqlState.unsafeQueries.find(({ query }) => query.includes("WITH claimed AS"));
      expect(renewQuery?.parameters).toEqual([
        "ws-1:evt-1:rt-1:dest-1",
        claimQuery?.parameters[6],
        60_000,
      ]);

      finishPut?.();
      await processing;
      expect(message.ack).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not settle or ACK after edge renewal loses the owner token", async () => {
    vi.useFakeTimers();
    try {
      sqlState.destinations = [destination("r2", { bucket: "events" })];
      sqlState.idempotencyRenew = [];
      let finishPut: (() => void) | undefined;
      const put = vi.fn(() => new Promise<void>((resolve) => {
        finishPut = resolve;
      }));
      const message = queueMessage();
      const processing = worker.queue(
        batch("axel-delivery", [message]),
        env({ EVENTS_RAW: { put }, IDEMPOTENCY_CLAIM_LEASE_MS: "60000" }),
        executionContext(),
      );

      await vi.advanceTimersByTimeAsync(20_000);
      finishPut?.();
      await processing;

      expect(message.ack).not.toHaveBeenCalled();
      expect(message.retry).toHaveBeenCalledOnce();
      expect(sqlState.unsafeQueries.some(({ query }) => query.includes("SET state = $3::text"))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("auto-trips the breaker open when a failure crosses the threshold (b3)", async () => {
    sqlState.destinations = [destination("http", { url: "https://receiver.example" })];
    // The failure-bump UPDATE reports the counter is now at the threshold.
    sqlState.breakerBump = [{ circuit_state: "closed", circuit_consecutive_failures: 5, circuit_threshold_failures: 5 }];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 })); // retry-class failure
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    // The trip UPDATE (circuit_state = 'open') was issued.
    expect(sqlState.queries.some((q) => /circuit_state = 'open'/.test(q))).toBe(true);
  });

  it("resets the breaker to closed on a successful delivery (b3)", async () => {
    // Loaded breaker is 'open' but past its cooldown → the shared breaker core
    // atomically claims the half_open probe slot, delivers, and a success then
    // resets it to closed — the full open→half_open→closed cycle now completes
    // on the edge alone (it previously needed delivery-service traffic).
    sqlState.destinations = [
      {
        ...destination("http", { url: "https://receiver.example" }),
        circuit_state: "open",
        circuit_opened_at: "2020-01-01T00:00:00.000Z",
        circuit_half_open_at: null,
        circuit_cooldown_seconds: 60,
        delivery_paused: false,
        retry_after_until: null,
      },
    ];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    // The probe-claim transition was attempted...
    expect(sqlState.queries.some((q) => /circuit_state = 'half_open'/.test(q))).toBe(true);
    // ...and the successful probe closed the breaker.
    expect(sqlState.queries.some((q) => /circuit_state = 'closed'/.test(q))).toBe(true);
  });

  it("holds off (retry) when another worker already claimed the half_open probe", async () => {
    // Same open-past-cooldown state, but the conditional flip UPDATE reports
    // zero rows — a concurrent worker won the probe slot. Single-probe rule:
    // this message retries instead of piling onto the recovering destination.
    sqlState.breakerFlip = [];
    sqlState.destinations = [
      {
        ...destination("http", { url: "https://receiver.example" }),
        circuit_state: "open",
        circuit_opened_at: "2020-01-01T00:00:00.000Z",
        circuit_half_open_at: null,
        circuit_cooldown_seconds: 60,
        delivery_paused: false,
        retry_after_until: null,
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(fetchSpy).not.toHaveBeenCalled(); // no delivery attempt
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "retry",
      response: expect.objectContaining({ skipped: "half_open_probe_in_flight" }),
    }));
  });

  it("reopens a half_open breaker whose probe timed out instead of trapping it (escape valve)", async () => {
    // half_open with a probe timestamp older than the cooldown → the shared
    // core flips back to open so the cooldown timer runs again; this message
    // retries. Previously the edge held half_open forever.
    sqlState.destinations = [
      {
        ...destination("http", { url: "https://receiver.example" }),
        circuit_state: "half_open",
        circuit_opened_at: "2020-01-01T00:00:00.000Z",
        circuit_half_open_at: "2020-01-01T00:00:00.000Z",
        circuit_cooldown_seconds: 60,
        delivery_paused: false,
        retry_after_until: null,
      },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledOnce();
    // The half_open→open reopen transition was issued.
    expect(sqlState.queries.some((q) => /circuit_state = 'open'/.test(q))).toBe(true);
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "retry",
      response: expect.objectContaining({ skipped: "half_open_probe_timed_out" }),
    }));
  });

  it("writes R2 destinations and acks the queue message", async () => {
    sqlState.destinations = [destination("r2", { bucket: "events", key_prefix: "exports" })];
    const put = vi.fn().mockResolvedValue(undefined);
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({ EVENTS_RAW: { put } }), executionContext());

    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^exports\/ws-1\/\d{4}-\d{2}-\d{2}\/evt-1-dest-1\.json$/),
      expect.any(Uint8Array),
      expect.objectContaining({
        httpMetadata: { contentType: "application/json" },
        customMetadata: {
          event_id: "evt-1",
          workspace_id: "ws-1",
          destination_id: "dest-1",
        },
      }),
    );
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("writes S3-compatible virtual-hosted endpoint URLs", async () => {
    sqlState.destinations = [
      destination("s3", {
        bucket: "archive",
        region: "auto",
        access_key_id: "tid_test",
        secret_access_key: "tsec_test",
        endpoint: "https://t3.storage.dev",
        addressing_style: "virtual_hosted",
        key_template: "{event_id}.json",
      }),
    ];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    const target = fetchMock.mock.calls[0]?.[0];
    const url = target instanceof Request ? target.url : String(target);
    expect(url).toBe("https://archive.t3.storage.dev/evt-1.json");
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("forwards native-runtime destinations to the Render delivery service", async () => {
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ status: "success", response: { native: true } }), { status: 200 }));
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example/",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(fetchMock).toHaveBeenCalledWith("https://delivery.example/deliver", expect.objectContaining({
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-axel-shared-secret": "shared",
      },
    }));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "success",
      response: expect.objectContaining({
        destination_type: "mongodb",
        forwarded_to_native: true,
        native_http_status: 200,
        native: true,
      }),
    }));
  });

  it("retries when native forwarding genuinely fails (503, no re-enqueue)", async () => {
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "retry", response: { error: "temporarily unavailable" } }), { status: 503 }),
    );
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("RETRIES (does not dead-letter) when delivery-service returns 401 — operational, not a terminal verdict", async () => {
    // Regression: a 401 (shared-secret mismatch during rotation), 500, 502, etc.
    // from OUR delivery-service is operational — it must RETRY, not dead-letter
    // every in-flight native delivery for the rotation window. A terminal verdict
    // arrives only as HTTP 200 + body.status="dead" (asserted below).
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "shared secret mismatch" }), { status: 401 }),
    );
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    // No dead_letters row written — a 401 is not "dead".
    expect(sqlState.deadLetters.length).toBe(0);
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "retry",
    }));
  });

  it("dead-letters (does not retry) on HTTP 200 + body.status='dead' — the only terminal native verdict", async () => {
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "dead", response: { error: "undefined_table" } }), { status: 200 }),
    );
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    // Terminal "dead" writes a dead_letters row so it's visible + replayable.
    expect(sqlState.deadLetters.length).toBe(1);
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "dead",
    }));
  });

  it("RETRIES when delivery-service returns 503 (transient platform error)", async () => {
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 503 }),
    );
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(sqlState.deadLetters.length).toBe(0);
  });

  it("ACKs (does not retry) when delivery-service reports 'rescheduled' — the retry was already re-enqueued there", async () => {
    // delivery-service re-enqueues attempt_no+1 itself (single retry owner). If
    // the edge ALSO retried its inbound message, both would deliver → double-POST.
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: "rescheduled", response: { error: "temporarily unavailable" } }), { status: 200 }),
    );
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    // Logged as the true outcome (a retry), not the internal "rescheduled" token.
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "retry",
    }));
  });

  it("acks unknown destinations as dead attempts", async () => {
    sqlState.destinations = [];
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env(), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(logDeliveryAttemptMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      status: "dead",
      response: { error: "unknown_destination" },
    }));
  });

  it("records explicit dead-letter messages and acks them", async () => {
    const message = queueMessage({
      workspace_id: "ws-1",
      event_id: "evt-1",
      source_id: "src-1",
      route_id: "rt-1",
      r2_key: "events/ws-1/evt-1.json",
      reason: "sandbox_breach",
      message: "CPU timeout",
      errored_at: "2026-05-02T12:00:00.000Z",
    });

    await worker.queue(batch("axel-dead-letter", [message]), env(), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(sqlState.deadLetters).toHaveLength(1);
    // The 10th column is the fingerprint, stamped from the EXACT stored
    // route_id/reason/message — assert it matches the shared formula so the
    // inbox recomputation + bulk-replay mute join will line up.
    const fp = await deadLetterFingerprint({ route_id: "rt-1", reason: "sandbox_breach", message: "CPU timeout" });
    expect(sqlState.deadLetters[0]).toEqual([
      "ws-1",
      "evt-1",
      "src-1",
      "rt-1",
      null,
      "events/ws-1/evt-1.json",
      "sandbox_breach",
      "CPU timeout",
      "2026-05-02T12:00:00.000Z",
      fp,
    ]);
  });

  it("persists destination_id when the router supplies it", async () => {
    const diagnostic = 'delivery_service_503: {"ok":false,"error":"delivery_overloaded"}';
    const storedDiagnostic = sanitizeConnectorDiagnosticForStorage(diagnostic, 400);
    const message = queueMessage({
      workspace_id: "ws-1",
      event_id: "evt-1",
      source_id: "src-1",
      route_id: "rt-1",
      destination_id: "dest-1",
      r2_key: "events/ws-1/evt-1.json",
      reason: "router_processing_failed",
      message: diagnostic,
      errored_at: "2026-05-02T12:00:00.000Z",
    });

    await worker.queue(batch("axel-dead-letter", [message]), env(), executionContext());

    expect(message.ack).toHaveBeenCalledOnce();
    const fp = await deadLetterFingerprint({
      route_id: "rt-1",
      reason: "router_processing_failed",
      message: storedDiagnostic,
    });
    expect(sqlState.deadLetters[0]).toEqual([
      "ws-1",
      "evt-1",
      "src-1",
      "rt-1",
      "dest-1",
      "events/ws-1/evt-1.json",
      "router_processing_failed",
      storedDiagnostic,
      "2026-05-02T12:00:00.000Z",
      fp,
    ]);
  });

  it("scrubs payload-value echoes out of the stored dead_letters message", async () => {
    sqlState.destinations = [destination("mongodb", { collection: "events" })];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "dead",
          response: {
            error:
              'duplicate key value violates unique constraint "u_email" DETAIL: Key (email)=(alice@example.com) already exists.',
          },
        }),
        { status: 200 },
      ),
    );
    const message = queueMessage();

    await worker.queue(batch("axel-delivery", [message]), env({
      DELIVERY_SERVICE_URL: "https://delivery.example",
      DELIVERY_SHARED_SECRET: "shared",
    }), executionContext());

    expect(sqlState.deadLetters.length).toBe(1);
    // Column order: (…, reason, message, …) — message is the 8th value.
    const storedMessage = (sqlState.deadLetters[0] as unknown[])[7] as string;
    expect(storedMessage).not.toContain("alice@example.com");
    expect(storedMessage).toContain("=([REDACTED])");
    expect(storedMessage).not.toContain("u_email");
  });

  it("sanitizes explicit DLQ messages before storing or fingerprinting them", async () => {
    const raw = 'router failed: payload={"note":"private webhook text"}; password=hunter2';
    const message = queueMessage({
      workspace_id: "ws-1",
      event_id: "evt-1",
      source_id: "src-1",
      route_id: "rt-1",
      r2_key: "events/ws-1/evt-1.json",
      reason: "router_processing_failed",
      message: raw,
      errored_at: "2026-05-02T12:00:00.000Z",
    });

    await worker.queue(batch("axel-dead-letter", [message]), env(), executionContext());

    const storedMessage = (sqlState.deadLetters[0] as unknown[])[7] as string;
    expect(storedMessage).not.toContain("private webhook text");
    expect(storedMessage).not.toContain("hunter2");
    expect(storedMessage).toContain("payload=[REDACTED]");
    expect((sqlState.deadLetters[0] as unknown[])[9]).toBe(
      await deadLetterFingerprint({
        route_id: "rt-1",
        reason: "router_processing_failed",
        message: storedMessage,
      }),
    );
  });

  it("deletes the queue-spill object when an auto-DLQ'd message carried one", async () => {
    // A message that exhausted max_retries on the delivery queue is auto-moved
    // to axel-dead-letter by Cloudflare with its body (incl. spill_r2_key)
    // intact. Recording it must also drop the oversized-payload spill object,
    // which previously leaked into R2 forever.
    const del = vi.fn().mockResolvedValue(undefined);
    const message = queueMessage({
      workspace_id: "ws-1",
      event_id: "evt-1",
      source_id: "src-1",
      route_id: "rt-1",
      destination_id: "dest-1",
      r2_key: "events/ws-1/evt-1.json",
      spill_r2_key: "queue-spill/ws-1/evt-1/dest-1/1.json",
      reason: "delivery_failed",
      message: "exhausted retries",
      errored_at: "2026-05-02T12:00:00.000Z",
    });

    await worker.queue(
      batch("axel-dead-letter", [message]),
      env({ EVENTS_RAW: { put: vi.fn(), delete: del } }),
      executionContext(),
    );

    expect(sqlState.deadLetters).toHaveLength(1);
    expect(del).toHaveBeenCalledWith("queue-spill/ws-1/evt-1/dest-1/1.json");
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("records a spill-less dead-letter without touching R2", async () => {
    const del = vi.fn().mockResolvedValue(undefined);
    const message = queueMessage({
      workspace_id: "ws-1",
      event_id: "evt-1",
      reason: "failed",
      message: "boom",
    });

    await worker.queue(
      batch("axel-dead-letter", [message]),
      env({ EVENTS_RAW: { put: vi.fn(), delete: del } }),
      executionContext(),
    );

    expect(sqlState.deadLetters).toHaveLength(1);
    expect(del).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("does not delete the spill when the dead_letters insert fails (retry keeps it for the next attempt)", async () => {
    sqlState.failDeadLetterInsert = true;
    const del = vi.fn().mockResolvedValue(undefined);
    const message = queueMessage({
      workspace_id: "ws-1",
      event_id: "evt-1",
      reason: "failed",
      message: "boom",
      spill_r2_key: "queue-spill/ws-1/evt-1/dest-1/1.json",
    });

    await worker.queue(
      batch("axel-dead-letter", [message]),
      env({ EVENTS_RAW: { put: vi.fn(), delete: del } }),
      executionContext(),
    );

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("retries dead-letter messages when the recorder cannot write", async () => {
    sqlState.failDeadLetterInsert = true;
    const message = queueMessage({ workspace_id: "ws-1", event_id: "evt-1", reason: "failed", message: "boom" });

    await worker.queue(batch("axel-dead-letter", [message]), env(), executionContext());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });
});

interface SqlMock {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  unsafe: (query: string, parameters?: unknown[]) => Promise<unknown[]>;
  end: (options?: unknown) => Promise<void>;
  json: (value: unknown) => unknown;
}

function destination(type: DestinationType, config: unknown) {
  return {
    id: "dest-1",
    workspace_id: "ws-1",
    type,
    config,
    credentials_ref: null,
  };
}

function env(overrides: Partial<Record<keyof import("../src/index.ts").Env, unknown>> = {}) {
  return {
    DATABASE_URL: "postgres://localhost/test",
    EVENTS_RAW: { put: vi.fn().mockResolvedValue(undefined) },
    DELIVERY_QUEUE: {},
    DEAD_LETTER_QUEUE: {},
    ...overrides,
  } as import("../src/index.ts").Env;
}

function queueMessage(body: unknown = destinationMessage()) {
  return {
    id: "msg-1",
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown> & { ack: ReturnType<typeof vi.fn>; retry: ReturnType<typeof vi.fn> };
}

function batch(queue: string, messages: Array<Message<unknown>>) {
  return { queue, messages } as MessageBatch<unknown>;
}

function executionContext() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  } as unknown as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
}

function destinationMessage(): DestinationQueueMessage {
  return {
    event_id: "evt-1",
    workspace_id: "ws-1",
    source_id: "src-1",
    route_id: "rt-1",
    destination_id: "dest-1",
    r2_key: "events/ws-1/evt-1.json",
    received_at: "2026-05-02T12:00:00.000Z",
    enqueued_at: "2026-05-02T12:00:01.000Z",
    attempt_no: 1,
    max_attempts: 12,
    idempotency_key: "ws-1:evt-1:rt-1:dest-1",
    content_type: "application/json",
    size_bytes: 17,
    payload: { hello: "world" },
    headers: {},
    query: {},
    is_test: false,
  };
}
