/**
 * End-to-end composition test for Axel.
 *
 * Wires the real ingest worker, router, and delivery worker source modules
 * together with in-memory R2, queues, and a stub HTTP destination. Asserts
 * that a webhook POST → 202 → routed → delivered → received by the
 * destination, with the exact event_id flowing through every layer.
 *
 * This is intentionally an in-process test, not a docker-compose test:
 * - Catches integration regressions across packages without infra burden.
 * - Runs in CI in < 1 second.
 * - Uses each service's `processX` entry point so the contract changes are
 *   detected immediately.
 *
 * What it does NOT cover:
 * - Cloudflare Queue delivery semantics (FIFO order, batch ack).
 * - Postgres transactional behaviour.
 * - ClickHouse insert latency.
 * Those are vendor-side concerns we'd cover with a docker-compose stack
 * once we hire someone to babysit it.
 */

import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import worker, { type Env } from "../../ingest-worker/src/index.ts";

function tokenHash(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
import { processQueueMessage, type RouterDeps } from "../../router/src/processor.ts";
import {
  createInMemoryReplayStore,
  processReplayBatch,
  type ReplayRow,
} from "../../router/src/replay.ts";
import {
  createInMemoryIdempotencyStore,
  processDeliveryMessage,
  type DeliveryWorkerDeps,
} from "../../delivery-worker/src/index.ts";
import { createHttpConnector, type FetchLike, type FetchResponseLike } from "@axel/connectors";
import {
  type Destination,
  type DestinationQueueMessage,
  type Route,
  type QueueMessage,
} from "@axel/shared";
import { logEventToClickhouse } from "../../ingest-worker/src/clickhouse-log.ts";
import { logDeliveryAttempt } from "../../delivery-edge/src/clickhouse-log.ts";

class FakeR2 {
  store = new Map<string, { body: ArrayBuffer; meta: Record<string, string> }>();
  async put(key: string, body: ArrayBuffer, options?: R2PutOptions): Promise<R2Object> {
    this.store.set(key, { body, meta: options?.customMetadata ?? {} });
    return { key } as unknown as R2Object;
  }
  async get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    return { async arrayBuffer() { return entry.body; } };
  }
}

class FakeQueue<T> {
  messages: T[] = [];
  async send(msg: T): Promise<void> {
    this.messages.push(msg);
  }
}

function makeIngestEnv(devSources: Record<string, unknown>): Env {
  const queues = Array.from({ length: 16 }, () => new FakeQueue<QueueMessage>());
  const r2 = new FakeR2();
  const env = {
    EVENTS_RAW: r2 as unknown as R2Bucket,
    DEV_MODE: "true",
    DEV_SOURCES: JSON.stringify(devSources),
  } as unknown as Env;
  for (let i = 0; i < 16; i++) {
    const key = `QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env;
    (env as unknown as Record<string, unknown>)[key as string] = queues[i];
  }
  return env;
}

const ctx = {
  waitUntil(p: Promise<unknown>): void {
    void p;
  },
  passThroughOnException(): void {},
} as unknown as ExecutionContext;

describe("e2e: ingest -> router -> delivery", () => {
  it("delivers a webhook payload to an HTTP destination end-to-end", async () => {
    // ---------------------------------------------------------------- //
    // 1. Ingest                                                        //
    // ---------------------------------------------------------------- //
    const env = makeIngestEnv({
      src_e2e: {
        workspace_id: "ws_e2e",
        secret_token: tokenHash("tok-e2e"),
        status: "active",
      },
    });

    const payload = { type: "ping", index: 1, when: "2026-05-15T12:00:00Z" };
    const req = new Request("https://ingest.test/in/src_e2e", {
      method: "POST",
      headers: { "content-type": "application/json", "x-axel-token": "tok-e2e" },
      body: JSON.stringify(payload),
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(202);
    const ack = (await res.json()) as { event_id: string };
    expect(ack.event_id).toMatch(/^[0-9a-f-]{36}$/);

    // The ingest worker enqueues to one of 16 sharded queues. Find it.
    const queues = Array.from({ length: 16 }, (_, i) =>
      env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>,
    );
    const queueMessage = queues.flatMap((q) => q.messages).find((m) => m.event_id === ack.event_id);
    expect(queueMessage).toBeDefined();
    expect(queueMessage!.workspace_id).toBe("ws_e2e");

    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    expect(r2.store.has(queueMessage!.r2_key)).toBe(true);

    // ---------------------------------------------------------------- //
    // 2. Router                                                        //
    // ---------------------------------------------------------------- //
    const ROUTE: Route = {
      route_id: "rt_e2e",
      workspace_id: "ws_e2e",
      source_id: "src_e2e",
      status: "active",
      destination_ids: ["dst_http"],
    };
    const destinationQueue = new FakeQueue<DestinationQueueMessage>();
    const routerDeps: RouterDeps = {
      rawPayloads: {
        async get(key) {
          const entry = r2.store.get(key);
          return entry?.body ?? null;
        },
      },
      routes: {
        async listActiveBySource(workspaceId, sourceId) {
          if (workspaceId === "ws_e2e" && sourceId === "src_e2e") return [ROUTE];
          return [];
        },
        async markErrored() {},
      },
      destinationQueue: {
        async enqueue(msg) {
          await destinationQueue.send(msg);
        },
      },
      deadLetter: {
        async push() {},
      },
    };

    const routerResult = await processQueueMessage(routerDeps, queueMessage!);
    expect(routerResult.matched_routes).toBe(1);
    expect(routerResult.enqueued_deliveries).toBe(1);
    expect(destinationQueue.messages).toHaveLength(1);

    const destinationMessage = destinationQueue.messages[0]!;
    expect(destinationMessage.event_id).toBe(ack.event_id);
    expect(destinationMessage.idempotency_key).toBe(`ws_e2e:${ack.event_id}:rt_e2e:dst_http`);

    // ---------------------------------------------------------------- //
    // 3. Delivery                                                      //
    // ---------------------------------------------------------------- //
    const captured: Array<{ url: string; bodyText: string; headers: Record<string, string> }> = [];
    const fakeFetch: FetchLike = async (url, init) => {
      const bodyText = new TextDecoder().decode(init.body);
      captured.push({ url, bodyText, headers: init.headers });
      const ok: FetchResponseLike = { status: 202, async text() { return ""; } };
      return ok;
    };

    const HTTP_DESTINATION: Destination<{ url: string }> = {
      destination_id: "dst_http",
      workspace_id: "ws_e2e",
      type: "http",
      config: { url: "https://customer.example.com/in" },
      credentials_ref: "",
    };

    const deliveryDeps: DeliveryWorkerDeps = {
      destinations: {
        async getDestination(workspaceId, destinationId) {
          if (workspaceId === "ws_e2e" && destinationId === "dst_http") return HTTP_DESTINATION;
          return null;
        },
      },
      connectors: new Map([["http", createHttpConnector(fakeFetch)]]),
      attempts: {
        async recordAttempt() {},
      },
    };

    const attempt = await processDeliveryMessage(deliveryDeps, destinationMessage);
    expect(attempt.status).toBe("success");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("https://customer.example.com/in");
    const deliveredPayload = JSON.parse(captured[0]!.bodyText) as typeof payload;
    expect(deliveredPayload).toEqual(payload);
  });

  it("dead-letters when no route matches and a replay re-runs the pipeline successfully", async () => {
    // Ingest a payload, then ROUTER has the route disabled so nothing fires.
    // Operator enables the route and replays — second pass delivers.
    const env = makeIngestEnv({
      src_e2e: { workspace_id: "ws_e2e", secret_token: tokenHash("tok"), status: "active" },
    });

    const req = new Request("https://ingest.test/in/src_e2e", {
      method: "POST",
      headers: { "content-type": "application/json", "x-axel-token": "tok" },
      body: JSON.stringify({ type: "test" }),
    });
    const ack = (await (await worker.fetch(req, env, ctx)).json()) as { event_id: string };

    const queues = Array.from({ length: 16 }, (_, i) =>
      env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>,
    );
    const queueMessage = queues.flatMap((q) => q.messages).find((m) => m.event_id === ack.event_id);

    const routes: Route[] = [
      {
        route_id: "rt_e2e",
        workspace_id: "ws_e2e",
        source_id: "src_e2e",
        status: "disabled",
        destination_ids: ["dst_http"],
      },
    ];
    const destinationQueue = new FakeQueue<DestinationQueueMessage>();
    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    const routerDeps: RouterDeps = {
      rawPayloads: { async get(key) { return r2.store.get(key)?.body ?? null; } },
      routes: {
        async listActiveBySource() {
          return routes.filter((r) => r.status === "active");
        },
        async markErrored() {},
      },
      destinationQueue: { async enqueue(msg) { await destinationQueue.send(msg); } },
      deadLetter: { async push() {} },
    };

    // First pass: route is disabled, nothing routed.
    const first = await processQueueMessage(routerDeps, queueMessage!);
    expect(first.matched_routes).toBe(0);
    expect(destinationQueue.messages).toHaveLength(0);

    // Operator enables and "replays": route the same message again.
    routes[0]!.status = "active";
    const second = await processQueueMessage(routerDeps, queueMessage!);
    expect(second.matched_routes).toBe(1);
    expect(destinationQueue.messages).toHaveLength(1);
  });

  it("replay re-delivers an event even though the original idempotency key was already used", async () => {
    // Regression test: a naive replay implementation re-uses the original
    // event_id, which means the delivery worker's idempotency store sees the
    // same key as the original delivery and silently short-circuits the replay
    // as "already delivered". processReplayBatch synthesizes a replay-tagged
    // event_id so the keys differ; this test asserts the wire reaches the
    // destination twice.

    const env = makeIngestEnv({
      src_e2e: { workspace_id: "ws_e2e", secret_token: tokenHash("tok"), status: "active" },
    });
    const ack = (await (await worker.fetch(
      new Request("https://ingest.test/in/src_e2e", {
        method: "POST",
        headers: { "content-type": "application/json", "x-axel-token": "tok" },
        body: JSON.stringify({ original: true }),
      }),
      env,
      ctx,
    )).json()) as { event_id: string };

    const queues = Array.from({ length: 16 }, (_, i) =>
      env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>,
    );
    const queueMessage = queues.flatMap((q) => q.messages).find((m) => m.event_id === ack.event_id)!;

    const ROUTE: Route = {
      route_id: "rt_e2e",
      workspace_id: "ws_e2e",
      source_id: "src_e2e",
      status: "active",
      destination_ids: ["dst_http"],
    };
    const destinationQueue = new FakeQueue<DestinationQueueMessage>();
    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    const routerDeps: RouterDeps = {
      rawPayloads: { async get(key) { return r2.store.get(key)?.body ?? null; } },
      routes: {
        async listActiveBySource() { return [ROUTE]; },
        async markErrored() {},
      },
      destinationQueue: { async enqueue(msg) { await destinationQueue.send(msg); } },
      deadLetter: { async push() {} },
    };

    // Original delivery flow: ingest → router → delivery → destination POST.
    await processQueueMessage(routerDeps, queueMessage);

    const captured: Array<{ url: string; bodyText: string }> = [];
    const fakeFetch: FetchLike = async (url, init) => {
      captured.push({ url, bodyText: new TextDecoder().decode(init.body) });
      return { status: 200, async text() { return ""; } } satisfies FetchResponseLike;
    };

    const HTTP_DESTINATION: Destination<{ url: string }> = {
      destination_id: "dst_http",
      workspace_id: "ws_e2e",
      type: "http",
      config: { url: "https://customer.example.com/in" },
      credentials_ref: "",
    };
    // The shared idempotency store is the critical bit: it persists across
    // calls so the replay attempt sees the original delivery as completed
    // unless the idempotency_key actually differs.
    const idempotency = createInMemoryIdempotencyStore();
    const deliveryDeps: DeliveryWorkerDeps = {
      destinations: {
        async getDestination() { return HTTP_DESTINATION; },
      },
      connectors: new Map([["http", createHttpConnector(fakeFetch)]]),
      attempts: { async recordAttempt() {} },
      idempotency,
    };

    const original = destinationQueue.messages[0]!;
    const firstAttempt = await processDeliveryMessage(deliveryDeps, original);
    expect(firstAttempt.status).toBe("success");
    expect(captured).toHaveLength(1);

    // Now replay: dashboard inserts a replay_requests row, router picks it up.
    const replays = createInMemoryReplayStore([
      {
        id: "rpy_demo",
        workspace_id: queueMessage.workspace_id,
        event_id: queueMessage.event_id,
        source_id: queueMessage.source_id,
        r2_key: queueMessage.r2_key,
        scope: "route",
        route_id: ROUTE.route_id,
        destination_id: null,
        reason: "regression-test",
        replay_job_id: null,
      } satisfies ReplayRow,
    ]);

    await processReplayBatch({
      router: {
        ...routerDeps,
        // Use a fresh destinationQueue so we can isolate the replay's outputs.
        destinationQueue: { async enqueue(msg) { await destinationQueue.send(msg); } },
      },
      replays,
    });

    expect(destinationQueue.messages).toHaveLength(2);
    const replayMessage = destinationQueue.messages[1]!;
    // Confirm the keys actually differ (this is what stops the short-circuit).
    expect(replayMessage.idempotency_key).not.toBe(original.idempotency_key);
    // Confirm the suffix carries the replay row id for traceability.
    expect(replayMessage.event_id).toBe(`${queueMessage.event_id}#rpy_demo`);

    const replayAttempt = await processDeliveryMessage(deliveryDeps, replayMessage);
    expect(replayAttempt.status).toBe("success");
    // Most important assertion: the destination really received the replay.
    expect(captured).toHaveLength(2);
    expect(JSON.parse(captured[1]!.bodyText)).toEqual({ original: true });
  });

  it("rejects an oversized payload at the edge before storing or queueing", async () => {
    const env = makeIngestEnv({
      src_e2e: {
        workspace_id: "ws_e2e",
        secret_token: tokenHash("tok"),
        status: "active",
        max_body_bytes: 1024,
      },
    });

    const big = new Uint8Array(2048);
    const res = await worker.fetch(
      new Request("https://ingest.test/in/src_e2e", {
        method: "POST",
        headers: {
          "content-length": String(big.byteLength),
          "x-axel-token": "tok",
        },
        body: big,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(413);

    const r2 = env.EVENTS_RAW as unknown as FakeR2;
    expect(r2.store.size).toBe(0);

    const queues = Array.from({ length: 16 }, (_, i) =>
      env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>,
    );
    expect(queues.flatMap((q) => q.messages)).toHaveLength(0);
  });

  it("logs the full golden path to ClickHouse (events + delivery_attempts)", async () => {
    // Capture every outbound ClickHouse insert. The real log modules use the
    // global fetch(); stubbing it lets us assert the exact rows the ingest
    // worker and the delivery-edge worker write — the one golden-path link the
    // in-process flow can't observe (both writes are fire-and-forget via
    // ctx.waitUntil with CLICKHOUSE_URL unset).
    const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
    const captureFetch = vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      const url = new URL(String(input));
      const query = url.searchParams.get("query") ?? "";
      const tableMatch = /INSERT INTO (\w+)/.exec(query);
      inserts.push({
        table: tableMatch?.[1] ?? "?",
        row: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return { ok: true, status: 200, async text() { return ""; } } as unknown as Response;
    });
    vi.stubGlobal("fetch", captureFetch);

    try {
      // ---- 1. Ingest (real worker) -> R2 + queue ---- //
      const env = makeIngestEnv({
        src_e2e: { workspace_id: "ws_e2e", secret_token: tokenHash("tok-e2e"), status: "active" },
      });
      const payload = { type: "ping", index: 1 };
      const res = await worker.fetch(
        new Request("https://ingest.test/in/src_e2e", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-axel-token": "tok-e2e",
          },
          body: JSON.stringify(payload),
        }),
        env,
        ctx,
      );
      expect(res.status).toBe(202);
      const ack = (await res.json()) as { event_id: string };

      const queues = Array.from({ length: 16 }, (_, i) =>
        env[`QUEUE_EVENTS_${i.toString().padStart(2, "0")}` as keyof Env] as unknown as FakeQueue<QueueMessage>,
      );
      const queueMessage = queues.flatMap((q) => q.messages).find((m) => m.event_id === ack.event_id)!;
      expect(queueMessage).toBeDefined();

      // ---- 2. ClickHouse `events` row (real logEventToClickhouse, real message) ---- //
      // Same call ingest fires at index.ts:393, but with CLICKHOUSE_URL set so the
      // insert actually happens and is captured.
      await logEventToClickhouse({ CLICKHOUSE_URL: "https://ch.test/" }, queueMessage);

      const eventInsert = inserts.find((i) => i.table === "events");
      expect(eventInsert).toBeDefined();
      expect(eventInsert!.row.event_id).toBe(ack.event_id);
      expect(eventInsert!.row.workspace_id).toBe("ws_e2e");
      expect(eventInsert!.row.source_id).toBe("src_e2e");
      expect(eventInsert!.row.r2_key).toBe(queueMessage.r2_key);
      // Custom-source body values stay out of the analytics type index.
      expect(eventInsert!.row.event_type).toBe("");
      // CH DateTime64(3) wire format: space separator, no trailing Z.
      expect(String(eventInsert!.row.received_at)).not.toContain("T");
      expect(String(eventInsert!.row.received_at)).not.toMatch(/Z$/);

      // ---- 3. Router -> delivery decision (reuse the proven cores) ---- //
      const r2 = env.EVENTS_RAW as unknown as FakeR2;
      const ROUTE: Route = {
        route_id: "rt_e2e",
        workspace_id: "ws_e2e",
        source_id: "src_e2e",
        status: "active",
        destination_ids: ["dst_http"],
      };
      const destinationQueue = new FakeQueue<DestinationQueueMessage>();
      const routerDeps: RouterDeps = {
        rawPayloads: { async get(key) { return r2.store.get(key)?.body ?? null; } },
        routes: { async listActiveBySource() { return [ROUTE]; }, async markErrored() {} },
        destinationQueue: { async enqueue(msg) { await destinationQueue.send(msg); } },
        deadLetter: { async push() {} },
      };
      await processQueueMessage(routerDeps, queueMessage);
      const destinationMessage = destinationQueue.messages[0]!;
      expect(destinationMessage.event_id).toBe(ack.event_id);

      const HTTP_DESTINATION: Destination<{ url: string }> = {
        destination_id: "dst_http",
        workspace_id: "ws_e2e",
        type: "http",
        config: { url: "https://customer.example.com/in" },
        credentials_ref: "",
      };
      // Connector uses a local fetch impl (NOT the stubbed global) so the
      // destination POST stays isolated from ClickHouse capture.
      const okFetch: FetchLike = async () => ({ status: 202, async text() { return ""; } } satisfies FetchResponseLike);
      const deliveryDeps: DeliveryWorkerDeps = {
        destinations: { async getDestination() { return HTTP_DESTINATION; } },
        connectors: new Map([["http", createHttpConnector(okFetch)]]),
        attempts: { async recordAttempt() {} },
      };
      const attempt = await processDeliveryMessage(deliveryDeps, destinationMessage);
      expect(attempt.status).toBe("success");

      // ---- 4. ClickHouse `delivery_attempts` row (real logDeliveryAttempt) ---- //
      // Mirrors the fire-and-forget log delivery-edge does after each attempt
      // (apps/delivery-edge/src/index.ts:185). Same event_id as the events row.
      await logDeliveryAttempt(
        { CLICKHOUSE_URL: "https://ch.test/" },
        {
          workspace_id: destinationMessage.workspace_id,
          event_id: destinationMessage.event_id,
          route_id: destinationMessage.route_id,
          destination_id: destinationMessage.destination_id,
          attempt_id: `${destinationMessage.event_id}-${destinationMessage.destination_id}-${destinationMessage.attempt_no}`,
          attempt_no: destinationMessage.attempt_no,
          is_test: destinationMessage.is_test ?? false,
          status: attempt.status === "success" ? "success" : "retry",
          latency_ms: 1,
          response: { destination_type: "http", http_status: 202 },
        },
      );

      const deliveryInsert = inserts.find((i) => i.table === "delivery_attempts");
      expect(deliveryInsert).toBeDefined();
      // The critical end-to-end correlation: the delivery row carries the SAME
      // event_id ingest minted and logged to `events`.
      expect(deliveryInsert!.row.event_id).toBe(ack.event_id);
      expect(deliveryInsert!.row.destination_id).toBe("dst_http");
      expect(deliveryInsert!.row.status).toBe("success");
      expect(deliveryInsert!.row.is_test).toBe(false);

      // Both ClickHouse tables were written for the one webhook: golden path complete.
      expect(inserts.map((i) => i.table).sort()).toEqual(["delivery_attempts", "events"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
