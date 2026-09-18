import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { capturingPg } from "@axel/test-utils";
import { AUTO_REPLAY_REASON, runDeadLetterTriageOnce } from "../src/dead-letter-triage-worker.ts";

type Fetch = typeof fetch;

function jevFetch(
  choice: string,
  confidence: number,
  capture?: { bodies: unknown[] },
): Fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    capture?.bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        model: "jev-latest",
        answers: {
          triage: { type: "choice", choice, confidence, probabilities: { [choice]: confidence } },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as Fetch;
}

const TEN_MIN_AGO = () => new Date(Date.now() - 10 * 60_000).toISOString();

function candidate(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "1",
    workspace_id: "ws_1",
    event_id: "evt_1",
    source_id: "src_1",
    route_id: "rt_1",
    destination_id: "dst_1",
    r2_key: "events/ws_1/src_1/evt_1.json",
    reason: "delivery_dead",
    message: "HTTP 503 from https://hooks.example.com/abc?token=secret: upstream timed out",
    fingerprint: "fp1",
    errored_at: TEN_MIN_AGO(),
    destination_type: "http",
    ...overrides,
  };
}

const STATS_QUIET = {
  rows: [{ same_1h: "1", same_24h: "1", resolved_24h: "2", replay_failures_24h: "0", is_muted: false }],
};
const CLAIMED = { rows: [{ id: "1" }], rowCount: 1 };
const NOT_IN_FLIGHT = { rows: [], rowCount: 0 };

function pool(responses: Array<{ rows: unknown[]; rowCount?: number }>, intercept?: (sql: string) => { rows: unknown[]; rowCount?: number } | undefined) {
  const pg = capturingPg({ responses, ...(intercept ? { intercept } : {}) });
  return { pool: pg as unknown as Pool, calls: pg.calls };
}

describe("runDeadLetterTriageOnce", () => {
  it("sends only allowlisted context to Jev, never the diagnostic text", async () => {
    const capture = { bodies: [] as unknown[] };
    const { pool: p } = pool([{ rows: [candidate()] }, STATS_QUIET, CLAIMED, NOT_IN_FLIGHT, { rows: [] }, { rows: [] }]);
    await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.97, capture) } });
    const text = JSON.stringify(capture.bodies[0]);
    expect(text).not.toContain("hooks.example.com");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("upstream timed out");
    const state = (capture.bodies[0] as { state: Record<string, unknown> }).state;
    expect(state.failure_reason).toBe("delivery_dead");
    expect(state.destination_type).toBe("http");
    expect(state.http_status).toBe(503);
    expect(state.signals).toEqual(["timeout"]);
    expect(state.replay_successes_24h).toBe(2);
  });

  it("stores the triage and queues a replay for a confident transient failure", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate()] }, STATS_QUIET, CLAIMED, NOT_IN_FLIGHT, { rows: [] }, { rows: [] }]);
    const s = await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.95) } });
    expect(s).toMatchObject({ scanned: 1, triaged: 1, auto_replayed: 1, by_reason: { transient: 1 } });

    const claim = calls.find((c) => /UPDATE dead_letters\s+SET triage_reason/.test(c.sql))!;
    expect(claim.params).toEqual(["1", "transient", 0.95]);
    expect(claim.sql).toContain("triaged_at IS NULL");

    const insert = calls.find((c) => /INSERT INTO replay_requests/.test(c.sql))!;
    expect(insert.params[0]).toMatch(/^rpa_/);
    expect(insert.params.slice(1)).toEqual([
      "ws_1", "evt_1", "src_1", "events/ws_1/src_1/evt_1.json", "destination", "rt_1", "dst_1", AUTO_REPLAY_REASON, "delivery_dead",
    ]);

    const stamp = calls.find((c) => /SET auto_replay_id/.test(c.sql))!;
    expect(stamp.params).toEqual(["1", insert.params[0]]);
  });

  it("uses route scope when the dead letter names no destination", async () => {
    const { pool: p, calls } = pool([
      { rows: [candidate({ destination_id: null, destination_type: null })] },
      STATS_QUIET, CLAIMED, NOT_IN_FLIGHT, { rows: [] }, { rows: [] },
    ]);
    await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.95) } });
    const insert = calls.find((c) => /INSERT INTO replay_requests/.test(c.sql))!;
    expect(insert.params[5]).toBe("route");
    expect(insert.params[7]).toBeNull();
  });

  it("labels but does not replay when Jev is not transient", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate()] }, STATS_QUIET, CLAIMED]);
    const s = await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("schema_mismatch", 0.99) } });
    expect(s).toMatchObject({ triaged: 1, auto_replayed: 0, by_reason: { schema_mismatch: 1 } });
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("does not replay a transient answer below the confidence floor", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate()] }, STATS_QUIET, CLAIMED]);
    const s = await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.7) } });
    expect(s.auto_replayed).toBe(0);
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("does not replay reasons a replay cannot fix", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate({ reason: "raw_payload_missing" })] }, STATS_QUIET, CLAIMED]);
    await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("respects an active mute on the fingerprint", async () => {
    const muted = { rows: [{ ...STATS_QUIET.rows[0], is_muted: true }] };
    const { pool: p, calls } = pool([{ rows: [candidate()] }, muted, CLAIMED]);
    await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("waits out the replay delay for very fresh failures", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate({ errored_at: new Date().toISOString() })] }, STATS_QUIET, CLAIMED]);
    await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("skips the insert when an identical replay is already in flight", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate()] }, STATS_QUIET, CLAIMED, { rows: [{ id: "rpy_x" }], rowCount: 1 }]);
    const s = await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(s.auto_replayed).toBe(0);
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("does nothing when autoReplay is off", async () => {
    const { pool: p, calls } = pool([{ rows: [candidate()] }, STATS_QUIET, CLAIMED]);
    const s = await runDeadLetterTriageOnce({ pool: p, autoReplay: false, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(s.triaged).toBe(1);
    expect(calls.some((c) => /INSERT INTO replay_requests/.test(c.sql))).toBe(false);
  });

  it("skips a row another writer claimed first", async () => {
    const { pool: p } = pool([{ rows: [candidate()] }, STATS_QUIET, { rows: [], rowCount: 0 }]);
    const s = await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(s).toMatchObject({ triaged: 0, skipped_claimed: 1, auto_replayed: 0 });
  });

  it("stops the tick on a Jev error and leaves rows untriaged", async () => {
    const boom = (async () => new Response("nope", { status: 401 })) as unknown as Fetch;
    const { pool: p, calls } = pool([{ rows: [candidate(), candidate({ id: "2" })] }, STATS_QUIET]);
    const s = await runDeadLetterTriageOnce({ pool: p, jev: { apiKey: "k", fetch: boom } });
    expect(s.jev_error).toBe("HTTP 401");
    expect(s.triaged).toBe(0);
    expect(calls.some((c) => /UPDATE dead_letters/.test(c.sql))).toBe(false);
  });

  it("caps replays per tick", async () => {
    const rows = [candidate({ id: "1" }), candidate({ id: "2", event_id: "evt_2" })];
    const { pool: p, calls } = pool([], (sql) => {
      if (/FROM dead_letters dl/.test(sql)) return { rows };
      if (/AS same_1h/.test(sql)) return STATS_QUIET;
      if (/SET triage_reason/.test(sql)) return CLAIMED;
      return { rows: [] };
    });
    const s = await runDeadLetterTriageOnce({ pool: p, maxAutoReplaysPerTick: 1, jev: { apiKey: "k", fetch: jevFetch("transient", 0.99) } });
    expect(s).toMatchObject({ triaged: 2, auto_replayed: 1 });
    expect(calls.filter((c) => /INSERT INTO replay_requests/.test(c.sql))).toHaveLength(1);
  });
});
