import { describe, expect, it, vi } from "vitest";
import type { Queryable } from "../lib/db";

// erasure-lifecycle imports ./db (and, transitively, the executor's pg/clickhouse
// clients) at module load; stub ./db so the real pool never loads. Tests inject
// deps.query/find/execute directly.
vi.mock("../lib/db", () => ({
  db: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

import { processErasureRequest } from "../lib/erasure-lifecycle";
import type { FindResult } from "../lib/erasure-finder";
import type { ExecuteResult } from "../lib/erasure-executor";

function capturingQuery() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query: Queryable = {
    async query(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  return { query, calls };
}

const foundResult = (count: number): FindResult => ({
  subjectIds: ["sub_x"],
  matches: Array.from({ length: count }, (_, i) => ({
    event_id: `evt_${i}`,
    r2_key: `events/ws_1/${i}`,
    received_at: "2026-06-01T00:00:00Z",
  })),
  coverage: "partial",
  indexWindowFrom: "2026-05-01T00:00:00Z",
  uncovered: [{ store: "pre-index window", reason: "x" }],
});

const executed = (dryRun: boolean): ExecuteResult => ({
  dryRun,
  executeEnabled: !dryRun,
  mutationsIssued: dryRun ? 0 : 7,
  plan: {
    eventIds: ["evt_0"],
    receivedAtFrom: null,
    receivedAtTo: null,
    chunkSize: 1000,
    clickhouse: [],
    postgres: [],
    r2: { knownKeys: [], derivedAtExecute: [] },
    outOfScope: [],
  },
  storeResults: dryRun ? [] : [{ store: "postgres:dead_letters", status: "deleted", count: 7 }],
  deletionManifestHash: dryRun ? null : "a".repeat(64),
});

describe("processErasureRequest", () => {
  it("runs received→erasing→partial and persists the audit row when erasing", async () => {
    const { query, calls } = capturingQuery();
    const find = vi.fn(async () => foundResult(2));
    const execute = vi.fn(async () => executed(false));

    const res = await processErasureRequest("ws_1", [{ kind: "email", value: "a@b.com" }], "usr_1", {}, {
      query,
      find: find as never,
      execute: execute as never,
      newId: () => "ers_1",
    });

    expect(res.state).toBe("partial");
    expect(res.executed).toBe(true);
    expect(res.matchedEventCount).toBe(2);
    expect(res.deletionManifestHash).toMatch(/^[0-9a-f]{64}$/);

    // Audit trail: INSERT 'finding' → UPDATE 'erasing' → UPDATE 'partial'.
    expect(calls[0]?.sql).toMatch(/INSERT INTO erasure_requests/);
    expect(calls[0]?.sql).toMatch(/'finding'/);
    // subject_ids inserted empty (filled on the 'erasing' update), never raw PII.
    expect(calls[0]?.params[2]).toEqual([]);
    expect(calls[0]?.params[3]).toMatch(/^[0-9a-f]{64}$/); // raw_identifier_fingerprint
    expect(calls.some((c) => /state = 'erasing'/.test(c.sql))).toBe(true);
    const terminal = calls[calls.length - 1];
    expect(terminal?.sql).toMatch(/state = \$2/);
    expect(terminal?.params[1]).toBe("partial");
    expect(terminal?.params[3]).toMatch(/^[0-9a-f]{64}$/); // deletion_manifest_hash
  });

  it("records 'found' (not 'partial') and nothing erased on a gate-off dry-run", async () => {
    const { query, calls } = capturingQuery();
    const res = await processErasureRequest("ws_1", [{ kind: "id", value: "cus_1" }], "usr_1", {}, {
      query,
      find: (async () => foundResult(1)) as never,
      execute: (async () => executed(true)) as never,
      newId: () => "ers_2",
    });

    expect(res.state).toBe("found");
    expect(res.executed).toBe(false);
    const terminal = calls[calls.length - 1];
    expect(terminal?.params[1]).toBe("found");
    expect(terminal?.params[4]).toMatch(/execution_disabled/);
  });

  it("blocks a likely shared-value mass erasure via the cardinality guard (no execute)", async () => {
    const { query, calls } = capturingQuery();
    const execute = vi.fn(async () => executed(false));

    const res = await processErasureRequest("ws_1", [{ kind: "email", value: "team@co.com" }], "usr_1",
      { maxEvents: 5 }, { query, find: (async () => foundResult(9)) as never, execute: execute as never, newId: () => "ers_3" });

    expect(res.state).toBe("blocked_large_set");
    expect(execute).not.toHaveBeenCalled();
    const guardUpdate = calls.find((c) => /cardinality_guard/.test(String(c.params[6] ?? "")));
    expect(guardUpdate?.sql).toMatch(/state = 'found'/); // persisted as located, not erased
  });

  it("proceeds past the guard when confirmLargeSet is set", async () => {
    const { query } = capturingQuery();
    const execute = vi.fn(async () => executed(false));
    const res = await processErasureRequest("ws_1", [{ kind: "email", value: "team@co.com" }], "usr_1",
      { maxEvents: 5, confirmLargeSet: true }, { query, find: (async () => foundResult(9)) as never, execute: execute as never, newId: () => "ers_4" });

    expect(execute).toHaveBeenCalledOnce();
    expect(res.state).toBe("partial");
  });

  it("marks 'failed' on a partial store failure but STILL persists store_results + manifest", async () => {
    const { query, calls } = capturingQuery();
    const partial: ExecuteResult = {
      ...executed(false),
      storeResults: [
        { store: "r2:axel-events-raw", status: "deleted", count: 4 },
        { store: "clickhouse:route_evaluations", status: "failed", count: 0, detail: "Code: 47" },
      ],
    };
    const res = await processErasureRequest("ws_1", [{ kind: "email", value: "a@b.com" }], "usr_1", {}, {
      query,
      find: (async () => foundResult(1)) as never,
      execute: (async () => partial) as never,
      newId: () => "ers_6",
    });

    expect(res.state).toBe("failed");
    const terminal = calls[calls.length - 1];
    expect(terminal?.params[1]).toBe("failed");
    // Audit preserved: store_results JSON + manifest hash are NOT null.
    expect(String(terminal?.params[2])).toMatch(/route_evaluations/);
    expect(terminal?.params[3]).toMatch(/^[0-9a-f]{64}$/);
    expect(String(terminal?.params[4])).toMatch(/incomplete_erasure/);
  });

  it("marks the request 'failed' when the finder throws", async () => {
    const { query, calls } = capturingQuery();
    const res = await processErasureRequest("ws_1", [{ kind: "email", value: "a@b.com" }], "usr_1", {}, {
      query,
      find: (async () => { throw new Error("index_unavailable"); }) as never,
      execute: (async () => executed(false)) as never,
      newId: () => "ers_5",
    });

    expect(res.state).toBe("failed");
    expect(res.error).toBe("index_unavailable");
    expect(calls.some((c) => /state = 'failed'/.test(c.sql))).toBe(true);
  });
});
