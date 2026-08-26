import { afterEach, describe, expect, it, vi } from "vitest";
import { capturingPg } from "@axel/test-utils";
import type { Pool } from "pg";
import { deadLetterFingerprint } from "@axel/shared";
import {
  createPgReplayStore,
  createPgRouteStore,
  createPgDeadLetterSink,
  createR2HttpRawPayloadStore,
  createR2HttpObjectStore,
  createR2HttpSpillReader,
  createCloudflareDeliveryQueueSink,
  createClickhousePayloadHints,
  buildReplayProcessorDeps,
} from "../src/replay-worker.ts";

interface PgCall {
  sql: string;
  params: unknown[];
}

function fakePool(responses: Array<{ rows: unknown[]; rowCount?: number }>): {
  pool: Pool;
  calls: PgCall[];
} {
  const pg = capturingPg({ responses });
  return { pool: pg as unknown as Pool, calls: pg.calls };
}

describe("replay-worker — ReplayStore (Postgres)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("claimPending uses SKIP LOCKED + UPDATE…RETURNING for race safety", async () => {
    const { pool, calls } = fakePool([
      {
        rows: [
          {
            id: "rpl_1",
            workspace_id: "ws_1",
            event_id: "evt_1",
            source_id: "src_1",
            r2_key: "events/ws_1/evt_1.json",
            scope: "route",
            route_id: "rt_1",
            destination_id: null,
            reason: null,
            replay_job_id: null,
          },
        ],
      },
    ]);
    const store = createPgReplayStore(pool);
    const rows = await store.claimPending(16);
    expect(rows).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(/SKIP LOCKED/);
    expect(calls[0]?.sql).toMatch(/UPDATE replay_requests/);
    expect(calls[0]?.sql).toMatch(/state = 'in_progress'/);
    // The worker reads replay_job_id off the claimed row to advance/finish a
    // tracked job; it must be in the RETURNING list.
    expect(calls[0]?.sql).toMatch(/rr\.replay_job_id/);
    expect(calls[0]?.params).toEqual([16]);
    // No tracked job on the claimed row => no replay_jobs 'running' stamp.
    expect(calls).toHaveLength(1);
  });

  it("claimPending stamps replay_jobs running once per distinct job id claimed", async () => {
    const { pool, calls } = fakePool([
      {
        rows: [
          { id: "rpl_1", workspace_id: "ws_1", event_id: "e1", source_id: "s1", r2_key: "k1", scope: "route", route_id: null, destination_id: null, reason: null, replay_job_id: "rpyjob_1" },
          { id: "rpl_2", workspace_id: "ws_1", event_id: "e2", source_id: "s1", r2_key: "k2", scope: "route", route_id: null, destination_id: null, reason: null, replay_job_id: "rpyjob_1" },
        ],
      },
      { rows: [], rowCount: 1 },
    ]);
    const store = createPgReplayStore(pool);
    await store.claimPending(16);
    // 1 claim + exactly 1 running-stamp (deduped to the single distinct job id).
    expect(calls).toHaveLength(2);
    expect(calls[1]?.sql).toMatch(/UPDATE replay_jobs/);
    expect(calls[1]?.sql).toMatch(/state = 'running'/);
    expect(calls[1]?.sql).toMatch(/AND state = 'pending'/);
    expect(calls[1]?.params).toEqual(["rpyjob_1"]);
  });

  it("markDone transitions row to done with finished_at and RETURNS replay_job_id", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const store = createPgReplayStore(pool);
    await store.markDone("rpl_1", { replay_id: "rpl_1", event_id: "evt_1", matched_routes: 1, skipped_routes: 0, enqueued_deliveries: 1, dead_lettered: 0 });
    expect(calls[0]?.sql).toMatch(/state = 'done'/);
    expect(calls[0]?.sql).toMatch(/RETURNING replay_job_id/);
    expect(calls[0]?.params).toEqual(["rpl_1"]);
    // No replay_job_id on the row => no job advance/finish queries fire.
    expect(calls).toHaveLength(1);
  });

  it("markFailed records the error message capped at 1000 chars and RETURNS replay_job_id", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const store = createPgReplayStore(pool);
    const huge = "x".repeat(2000);
    await store.markFailed("rpl_1", huge);
    expect(calls[0]?.sql).toMatch(/RETURNING replay_job_id/);
    expect(calls[0]?.params[0]).toBe("rpl_1");
    expect((calls[0]?.params[1] as string).length).toBe(1000);
    expect(calls).toHaveLength(1);
  });

  it("markFailed strips payload echoes and secrets from replay_requests", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const store = createPgReplayStore(pool);
    await store.markFailed(
      "rpl_1",
      'dispatch failed: payload={"email":"victim@example.test"}; password=hunter2',
    );

    const stored = calls[0]?.params[1] as string;
    expect(stored).not.toContain("victim@example.test");
    expect(stored).not.toContain("hunter2");
    expect(stored).toContain("payload=[REDACTED]");
  });

  it("markFailed advances + finishes the tracked job (the dispatch-failed terminal path)", async () => {
    const { pool, calls } = fakePool([
      // markFailed UPDATE replay_requests ... RETURNING replay_job_id
      { rows: [{ replay_job_id: "rpyjob_9" }], rowCount: 1 },
      // bumpReplayJobCounter: 'running' stamp
      { rows: [], rowCount: 0 },
      // bumpReplayJobCounter: counter bump
      { rows: [], rowCount: 1 },
      // finishReplayJobIfComplete: atomic finish-once UPDATE returns a row
      { rows: [{ workspace_id: "ws_1", succeeded_count: "0", failed_count: "1" }], rowCount: 1 },
      // emitReplayJobCompleteNotification: notifications INSERT
      { rows: [], rowCount: 1 },
    ]);
    const store = createPgReplayStore(pool);
    await store.markFailed("rpl_1", "r2_get_404: payload expired");
    // The dispatch-failed replay finishes its job entirely inside the worker:
    // mark-failed -> running -> counter -> finish-once -> notify.
    const sql = calls.map((c) => c.sql).join("\n");
    expect(sql).toMatch(/UPDATE replay_jobs[\s\S]*state = 'done'/);
    expect(sql).toMatch(/INSERT INTO notifications/);
    const notifyCall = calls.find((c) => /INSERT INTO notifications/.test(c.sql));
    expect(notifyCall?.params).toContain("replay_job_complete:rpyjob_9");
  });

  it("markDispatched is a no-op (row stays in_progress until delivery resolves)", async () => {
    const { pool, calls } = fakePool([]);
    const store = createPgReplayStore(pool);
    await store.markDispatched("rpl_1", { replay_id: "rpl_1", event_id: "evt_1", matched_routes: 1, skipped_routes: 0, enqueued_deliveries: 1, dead_lettered: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe("replay-worker — RouteStore (Postgres)", () => {
  it("returns empty when no active routes for source", async () => {
    const { pool } = fakePool([{ rows: [] }]);
    const store = createPgRouteStore(pool);
    const routes = await store.listActiveBySource("ws_1", "src_1");
    expect(routes).toEqual([]);
  });

  it("hydrates destination_ids per route", async () => {
    const { pool } = fakePool([
      {
        rows: [
          {
            id: "rt_1",
            workspace_id: "ws_1",
            source_id: "src_1",
            status: "active",
            engine: "declarative",
            filter_expression: null,
            transform_script: null,
          },
        ],
      },
      // SELECT field_selection FROM sources (added so the processor can project)
      { rows: [{ field_selection: null }] },
      {
        rows: [
          { route_id: "rt_1", destination_id: "dst_a", destination_type: "http" },
          { route_id: "rt_1", destination_id: "dst_b", destination_type: "mongodb" },
        ],
      },
    ]);
    const store = createPgRouteStore(pool);
    const routes = await store.listActiveBySource("ws_1", "src_1");
    expect(routes).toHaveLength(1);
    expect(routes[0]?.destination_ids).toEqual(["dst_a", "dst_b"]);
    expect(routes[0]?.destinationTypes).toEqual({ dst_a: "http", dst_b: "mongodb" });
    // null filter/transform should be omitted from the spread, not included as undefined
    expect("filter_expression" in (routes[0] ?? {})).toBe(false);
    expect("transform_script" in (routes[0] ?? {})).toBe(false);
  });

  it("hydrates destination_bindings per route so S3-parquet replays route natively", async () => {
    const { pool } = fakePool([
      {
        rows: [
          {
            id: "rt_1",
            workspace_id: "ws_1",
            source_id: "src_1",
            status: "active",
            engine: "declarative",
            filter_expression: null,
            transform_script: null,
          },
        ],
      },
      { rows: [{ field_selection: null }] },
      {
        rows: [
          { route_id: "rt_1", destination_id: "dst_s3", destination_type: "s3", binding: { format: "parquet" } },
          { route_id: "rt_1", destination_id: "dst_http", destination_type: "http", binding: null },
        ],
      },
    ]);
    const store = createPgRouteStore(pool);
    const routes = await store.listActiveBySource("ws_1", "src_1");
    // Without rd.binding, destination_bindings is empty and processor.ts:248 sees
    // null, so requiresNativeRuntimeDestination returns false and the S3-parquet
    // replay is mis-routed to the edge worker and dead-lettered. With it, the
    // parquet binding flows through and the replay routes to the native runtime.
    expect(routes[0]?.destination_bindings).toEqual({
      dst_s3: { format: "parquet" },
      dst_http: null,
    });
  });

  it("markErrored updates error_reason/error_message and flips status", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const store = createPgRouteStore(pool);
    await store.markErrored("rt_1", "filter_invalid", "boom");
    expect(calls[0]?.sql).toMatch(/status = 'errored'/);
    // Trailing null = no workspace scope (the RouteStore interface carries no
    // workspace id; the shared markRouteErrored takes an optional one).
    expect(calls[0]?.params).toEqual(["rt_1", "filter_invalid", "boom", null]);
  });
});

describe("replay-worker — DeadLetterSink (Postgres)", () => {
  it("inserts with ON CONFLICT DO NOTHING (idempotent)", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const sink = createPgDeadLetterSink(pool);
    await sink.push({
      workspace_id: "ws_1",
      event_id: "evt_1",
      source_id: "src_1",
      route_id: "rt_1",
      r2_key: "events/ws_1/evt_1.json",
      reason: "filter_invalid",
      message: "boom",
      errored_at: "2026-05-18T00:00:00Z",
    });
    expect(calls[0]?.sql).toMatch(/ON CONFLICT DO NOTHING/);
    // 9 params now — the 9th is the fingerprint, stamped from the same
    // route_id/reason/message so it matches the inbox + mute join.
    expect(calls[0]?.params).toHaveLength(9);
    expect(calls[0]?.params[8]).toBe(
      await deadLetterFingerprint({ route_id: "rt_1", reason: "filter_invalid", message: "boom" }),
    );
  });

  it("sanitizes the message before inserting and fingerprinting", async () => {
    const { pool, calls } = fakePool([{ rows: [] }]);
    const sink = createPgDeadLetterSink(pool);
    await sink.push({
      workspace_id: "ws_1",
      event_id: "evt_1",
      source_id: "src_1",
      route_id: "rt_1",
      r2_key: "events/ws_1/evt_1.json",
      reason: "connector_failed",
      message: 'row rejected: payload={"note":"private webhook text"}; api_key=opaque-secret',
      errored_at: "2026-05-18T00:00:00Z",
    });

    const stored = calls[0]?.params[6] as string;
    expect(stored).not.toContain("private webhook text");
    expect(stored).not.toContain("opaque-secret");
    expect(calls[0]?.params[8]).toBe(
      await deadLetterFingerprint({
        route_id: "rt_1",
        reason: "connector_failed",
        message: stored,
      }),
    );
  });
});

describe("replay-worker — R2 raw payload store", () => {
  it("returns null on 404", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const store = createR2HttpRawPayloadStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await store.get("events/ws_1/evt_1.json");
    expect(result).toBeNull();
  });

  it("returns the bytes and keeps R2 key slashes literal", async () => {
    const fetchImpl = vi.fn(async () => new Response("hello", { status: 200 }));
    const store = createR2HttpRawPayloadStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await store.get("events/ws/some key.json");
    expect(result).not.toBeNull();
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/objects/events/ws/some%20key.json");
    expect(url).not.toContain("%2F");
  });

  it("throws on non-404 errors so the replay row is marked failed", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const store = createR2HttpRawPayloadStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.get("k")).rejects.toThrow("r2_get_403");
    // 4xx is not retryable — a single attempt.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a transient Cloudflare 525 and succeeds", async () => {
    // 525 = "SSL handshake failed" — transient CF edge error, succeeds on retry.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("<!DOCTYPE html>", { status: 525 }))
      .mockResolvedValueOnce(new Response("hello", { status: 200 }));
    const store = createR2HttpRawPayloadStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await store.get("events/ws_1/evt_1.json");
    expect(result).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries on a persistent 5xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("<!DOCTYPE html>", { status: 525 }));
    const store = createR2HttpRawPayloadStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.get("k")).rejects.toThrow("r2_get_525");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("replay-worker — R2 spill reader", () => {
  const deps = {
    cloudflareAccountId: "acc",
    cloudflareApiToken: "tok",
    rawPayloadBucket: "axel-events-raw",
  };
  const SPILL_KEY = "queue-spill/ws-1/evt-1/dst-1/1.json";

  // JAVASCRIPT-38: the spill reader called the plain fetch helper while only
  // the raw-payload reader got the retry wrapper, so one Cloudflare edge blip
  // failed a hydrate and opened a Sentry issue.
  it("retries a transient Cloudflare 521 and succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("<!DOCTYPE html><html><title>Web server is down</title>", { status: 521 }))
      .mockResolvedValueOnce(new Response('{"payload":{},"headers":{},"query":{}}', { status: 200 }));
    const reader = createR2HttpSpillReader({ ...deps, fetchImpl: fetchImpl as unknown as typeof fetch });
    const result = await reader.get(SPILL_KEY);
    expect(result).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain(
      "/objects/queue-spill/ws-1/evt-1/dst-1/1.json",
    );
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("%2F");
  });

  it("collapses a Cloudflare HTML error page to a single fingerprintable marker", async () => {
    const html = [
      "<!DOCTYPE html>",
      '<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->',
      "<html><head><title>example.com | 521: Web server is down</title></head>",
      `<body>${"filler ".repeat(400)}</body></html>`,
    ].join("\n");
    const fetchImpl = vi.fn(async () => new Response(html, { status: 521 }));
    const reader = createR2HttpSpillReader({ ...deps, fetchImpl: fetchImpl as unknown as typeof fetch });

    const err = await reader.get(SPILL_KEY).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    // No raw HTML: the doctype and conditional comments were what Sentry read
    // as the issue title and as bogus stack frames.
    expect((err as Error).message).toBe("r2_get_521: <cloudflare html error: example.com | 521: Web server is down>");
    expect((err as Error).message).not.toContain("<!DOCTYPE");
  });

  it("returns null on 404 rather than treating it as an error", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const reader = createR2HttpSpillReader({ ...deps, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(reader.get(SPILL_KEY)).resolves.toBeNull();
  });

  // JAVASCRIPT-3M: a body cut mid-stream used to reach JSON.parse.
  it("rejects a body shorter than its declared content-length", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("x".repeat(64), { status: 200, headers: { "content-length": "131072" } }),
    );
    const reader = createR2HttpSpillReader({ ...deps, fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(reader.get(SPILL_KEY)).rejects.toThrow(/r2_get_truncated: .*\(64\/131072 bytes\)/);
  });

  it("accepts a complete body and a body with no content-length header", async () => {
    const body = '{"payload":{"a":1},"headers":{},"query":{}}';
    const withHeader = vi.fn(async () =>
      new Response(body, { status: 200, headers: { "content-length": String(body.length) } }),
    );
    const withoutHeader = vi.fn(async () => new Response(body, { status: 200 }));

    for (const fetchImpl of [withHeader, withoutHeader]) {
      const reader = createR2HttpSpillReader({ ...deps, fetchImpl: fetchImpl as unknown as typeof fetch });
      const buf = await reader.get(SPILL_KEY);
      expect(new TextDecoder().decode(buf!)).toBe(body);
    }
  });

  it("treats a delete 404 as success and retries a transient edge failure", async () => {
    const missing = vi.fn(async () => new Response("", { status: 404 }));
    const readerMissing = createR2HttpSpillReader({ ...deps, fetchImpl: missing as unknown as typeof fetch });
    await expect(readerMissing.delete(SPILL_KEY)).resolves.toBeUndefined();

    const flaky = vi
      .fn()
      .mockResolvedValueOnce(new Response("<!DOCTYPE html>", { status: 521 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    const readerFlaky = createR2HttpSpillReader({ ...deps, fetchImpl: flaky as unknown as typeof fetch });
    await expect(readerFlaky.delete(SPILL_KEY)).resolves.toBeUndefined();
    expect(flaky).toHaveBeenCalledTimes(2);
  });
});

describe("replay-worker — R2 object store (r2 destination connector)", () => {
  it("PUTs the event bytes with literal key slashes and subject metadata headers", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));
    const store = createR2HttpObjectStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = new TextEncoder().encode('{"hello":"world"}').buffer;
    await store.put("ws_1/123-dest_1.json", body, { workspace_id: "ws_1", destination_id: "dest_1" });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/r2/buckets/axel-events-raw/objects/ws_1/123-dest_1.json");
    expect(String(url)).not.toContain("%2F");
    expect((init as RequestInit).method).toBe("PUT");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["x-amz-meta-workspace_id"]).toBe("ws_1");
    expect(headers["x-amz-meta-destination_id"]).toBe("dest_1");
  });

  it("throws on a non-2xx so the delivery is retried/dead-lettered rather than silently lost", async () => {
    const fetchImpl = vi.fn(async () => new Response("denied", { status: 403 }));
    const store = createR2HttpObjectStore({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(store.put("k", new ArrayBuffer(2), {})).rejects.toThrow("r2_put_403");
  });
});

describe("replay-worker — CF delivery queue sink", () => {
  it("POSTs the message wrapped in { body } per CF Queues HTTP API", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const sink = createCloudflareDeliveryQueueSink({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      deliveryQueueId: "qid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await sink.enqueue({
      event_id: "evt_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      route_id: "rt_1",
      destination_id: "dst_1",
      r2_key: "k",
      received_at: "2026-05-18T00:00:00Z",
      enqueued_at: "2026-05-18T00:00:01Z",
      attempt_no: 1,
      max_attempts: 5,
      idempotency_key: "idk",
      content_type: "application/json",
      size_bytes: 100,
      payload: { hello: "world" },
      headers: {},
      query: {},
      is_test: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain("/queues/qid/messages");
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(body.body.event_id).toBe("evt_1");
  });

  it("throws on non-2xx so the replay batch reports failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const sink = createCloudflareDeliveryQueueSink({
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      deliveryQueueId: "qid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      sink.enqueue({
        event_id: "evt_1",
        workspace_id: "ws_1",
        source_id: "src_1",
        route_id: "rt_1",
        destination_id: "dst_1",
        r2_key: "k",
        received_at: "2026-05-18T00:00:00Z",
        enqueued_at: "2026-05-18T00:00:01Z",
        attempt_no: 1,
        max_attempts: 5,
        idempotency_key: "idk",
        content_type: "application/json",
        size_bytes: 0,
        payload: {},
        headers: {},
        query: {},
        is_test: false,
      }),
    ).rejects.toThrow("queue_enqueue_429");
  });
});

describe("replay-worker — processor wiring", () => {
  it("wires edge and native replay queues separately when both queue IDs are configured", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const { pool } = fakePool([]);
    const deps = buildReplayProcessorDeps({
      pool,
      cloudflareAccountId: "acc",
      cloudflareApiToken: "tok",
      rawPayloadBucket: "axel-events-raw",
      deliveryQueueId: "edge-qid",
      nativeDeliveryQueueId: "native-qid",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const message = {
      event_id: "evt_1",
      workspace_id: "ws_1",
      source_id: "src_1",
      route_id: "rt_1",
      destination_id: "dst_1",
      r2_key: "k",
      received_at: "2026-05-18T00:00:00Z",
      enqueued_at: "2026-05-18T00:00:01Z",
      attempt_no: 1,
      max_attempts: 5,
      idempotency_key: "idk",
      content_type: "application/json",
      size_bytes: 0,
      payload: {},
      headers: {},
      query: {},
      is_test: false,
    };

    await deps.router.destinationQueue.enqueue(message);
    expect(deps.router.nativeDestinationQueue).toBeDefined();
    await deps.router.nativeDestinationQueue?.enqueue(message);

    const urls = fetchImpl.mock.calls.map((call) => String(call[0]));
    expect(urls[0]).toContain("/queues/edge-qid/messages");
    expect(urls[1]).toContain("/queues/native-qid/messages");
  });
});

describe("replay-worker — ClickHouse hints", () => {
  it("returns null when the row is missing", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const hints = createClickhousePayloadHints({
      url: "https://ch.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await hints.resolveHints("evt_1", "k");
    expect(result).toBeNull();
  });

  it("bounds ClickHouse hint lookups", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const hints = createClickhousePayloadHints({
      url: "https://ch.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await hints.resolveHints("evt_1", "k");

    const url = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url.searchParams.get("max_execution_time")).toBe("5");
    expect(url.searchParams.get("max_memory_usage")).toBe("268435456");
    expect(url.searchParams.get("max_threads")).toBe("1");
    expect(url.searchParams.get("max_result_rows")).toBe("1");
  });

  it("converts ClickHouse DateTime64 string to ISO and parses headers/query JSON", async () => {
    const row = {
      received_at: "2026-05-18 12:34:56.789",
      content_type: "application/json",
      size_bytes: 42,
      shard: 3,
      headers_json: JSON.stringify({ "x-foo": "bar" }),
      query_json: JSON.stringify({ q: "1" }),
      is_test: false,
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [row] }), { status: 200 }),
    );
    const hints = createClickhousePayloadHints({
      url: "https://ch.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await hints.resolveHints("evt_1", "k");
    expect(result).toEqual({
      received_at: "2026-05-18T12:34:56.789Z",
      content_type: "application/json",
      size_bytes: 42,
      shard: 3,
      headers: { "x-foo": "bar" },
      query: { q: "1" },
      is_test: false,
    });
  });

  it("carries the original is_test forward so replaying a test event stays non-billable", async () => {
    const row = {
      received_at: "2026-05-18 12:34:56.789",
      content_type: "application/json",
      size_bytes: 42,
      shard: 3,
      headers_json: "{}",
      query_json: "{}",
      is_test: true,
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [row] }), { status: 200 }),
    );
    const hints = createClickhousePayloadHints({
      url: "https://ch.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await hints.resolveHints("evt_1", "k");
    expect(result?.is_test).toBe(true);
  });

  it("tolerates malformed headers_json by returning empty headers", async () => {
    const row = {
      received_at: "2026-05-18 00:00:00.000",
      content_type: "application/json",
      size_bytes: 0,
      shard: 0,
      headers_json: "{not-json",
      query_json: "{also-not-json",
      is_test: false,
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [row] }), { status: 200 }),
    );
    const hints = createClickhousePayloadHints({
      url: "https://ch.example",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await hints.resolveHints("evt_1", "k");
    expect(result?.headers).toEqual({});
    expect(result?.query).toEqual({});
  });
});
