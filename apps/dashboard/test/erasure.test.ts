import { afterEach, describe, expect, it, vi } from "vitest";
import type { Queryable } from "../lib/db";

// erasure-finder imports ./db at module load; stub it so the real pg pool never
// loads. Tests inject deps.query directly, so this stub's db() is never called.
vi.mock("../lib/db", () => ({
  db: () => ({ query: async () => ({ rows: [], rowCount: 0 }) }),
}));

import { deriveSubjectIdWeb } from "@axel/shared";
import { fakeClickhouse as sharedFakeClickhouse } from "@axel/test-utils";
import { deriveSubjectId, deriveSubjectIds, normalizeSubjectValue } from "../lib/erasure-subject-id";
import { findSubjectEvents } from "../lib/erasure-finder";
import { buildErasurePlan, executeErasure } from "../lib/erasure-executor";

afterEach(() => {
  delete process.env.ERASURE_EXECUTE_ENABLED;
  vi.restoreAllMocks();
});

describe("deriveSubjectId", () => {
  it("is deterministic and shaped sub_<64 hex>", () => {
    const a = deriveSubjectId("ws_1", "email", "a@b.com");
    const b = deriveSubjectId("ws_1", "email", "a@b.com");
    expect(a).toBe(b);
    expect(a).toMatch(/^sub_[0-9a-f]{64}$/);
  });

  it("normalizes email (case + whitespace) but not opaque ids", () => {
    expect(normalizeSubjectValue("email", "  A@B.CoM ")).toBe("a@b.com");
    expect(normalizeSubjectValue("id", " Cus_9 ")).toBe(" Cus_9 ");
    expect(deriveSubjectId("ws_1", "email", "  A@B.CoM ")).toBe(deriveSubjectId("ws_1", "email", "a@b.com"));
    expect(deriveSubjectId("ws_1", "id", "Cus_9")).not.toBe(deriveSubjectId("ws_1", "id", "cus_9"));
  });

  it("binds workspace and normalization version into the hash", () => {
    expect(deriveSubjectId("ws_1", "id", "x")).not.toBe(deriveSubjectId("ws_2", "id", "x"));
    expect(deriveSubjectId("ws_1", "id", "x", 1)).not.toBe(deriveSubjectId("ws_1", "id", "x", 2));
  });

  it("ingest WRITE path (Web Crypto) is byte-identical to the dashboard READ path (node:crypto)", async () => {
    // If these ever diverge, ingest indexes one subject_id and the finder looks
    // up a different one → erasure silently finds nothing. Lock the parity.
    const cases: Array<[string, string, string]> = [
      ["ws_1", "email", "  A@B.CoM "],
      ["ws_1", "id", "Cus_9"],
      ["ws_9", "email", "café-user@例え.jp"],
      ["ws_1", "", "no-kind-value"],
    ];
    for (const [ws, kind, value] of cases) {
      expect(await deriveSubjectIdWeb(ws, kind, value)).toBe(deriveSubjectId(ws, kind, value));
    }
  });

  it("deriveSubjectIds de-duplicates and skips empties", () => {
    const ids = deriveSubjectIds("ws_1", [
      { kind: "email", value: "a@b.com" },
      { kind: "email", value: "A@B.com" }, // same after normalize -> dropped
      { kind: "id", value: "cus_1" },
      { kind: "id", value: "" }, // skipped
    ]);
    expect(ids).toHaveLength(2);
  });
});

describe("findSubjectEvents", () => {
  const fakeQuery = (subjectRows: unknown[], coverageRow: unknown): Queryable => ({
    async query<T>(sql: string) {
      if (sql.includes("FROM erasure_subjects")) return { rows: subjectRows as T[], rowCount: subjectRows.length };
      if (sql.includes("FROM sources")) return { rows: [coverageRow] as T[], rowCount: 1 };
      return { rows: [] as T[], rowCount: 0 };
    },
  });

  it("returns unknown coverage when no identifiers are usable", async () => {
    const res = await findSubjectEvents("ws_1", [{ kind: "id", value: "" }], { query: fakeQuery([], {}) });
    expect(res.subjectIds).toEqual([]);
    expect(res.matches).toEqual([]);
    expect(res.coverage).toBe("unknown");
  });

  it("de-duplicates events indexed under multiple subject_ids and reports partial coverage", async () => {
    const subjectRows = [
      { event_id: "evt_1", r2_key: "events/ws_1/2026-06-01/evt_1", received_at: "2026-06-01T00:00:00Z" },
      { event_id: "evt_1", r2_key: "events/ws_1/2026-06-01/evt_1", received_at: "2026-06-01T00:00:00Z" }, // dup (email+id)
      { event_id: "evt_2", r2_key: "events/ws_1/2026-06-02/evt_2", received_at: "2026-06-02T00:00:00Z" },
    ];
    const res = await findSubjectEvents(
      "ws_1",
      [{ kind: "email", value: "a@b.com" }, { kind: "id", value: "cus_1" }],
      { query: fakeQuery(subjectRows, { window_from: "2026-05-01T00:00:00Z", configured_sources: 2 }) },
    );
    expect(res.subjectIds).toHaveLength(2);
    expect(res.matches.map((m) => m.event_id)).toEqual(["evt_1", "evt_2"]);
    expect(res.coverage).toBe("partial");
    expect(res.indexWindowFrom).toBe("2026-05-01T00:00:00Z");
    expect(res.uncovered.some((u) => u.store === "pre-index window")).toBe(true);
  });

  it("never claims full coverage; unknown when no source has indexing", async () => {
    const res = await findSubjectEvents(
      "ws_1",
      [{ kind: "id", value: "cus_1" }],
      { query: fakeQuery([], { window_from: null, configured_sources: 0 }) },
    );
    expect(res.coverage).toBe("unknown");
    expect(res.uncovered.some((u) => u.store === "index")).toBe(true);
  });
});

describe("buildErasurePlan", () => {
  const matches = [
    { event_id: "evt_a", r2_key: "events/ws_1/2026-06-01/evt_a", received_at: "2026-06-01T00:00:00Z" },
    { event_id: "evt_b", r2_key: "events/ws_1/2026-06-03/evt_b", received_at: "2026-06-03T00:00:00Z" },
  ];

  it("date-bounds the events mutation by toDate(received_at) and scopes by event_id", () => {
    const plan = buildErasurePlan("ws_1", matches);
    const events = plan.clickhouse.find((s) => s.table === "events")!;
    expect(events.statement).toContain("event_id IN ('evt_a', 'evt_b')");
    // Partition-prune on the partition expression with an unambiguous date
    // literal, ±1-day margin so a midnight clock-skew boundary can't exclude a row.
    expect(events.statement).toContain("toDate(received_at) BETWEEN toDate('2026-06-01') - 1 AND toDate('2026-06-03') + 1");
    expect(events.statement).toContain("mutations_sync = 1");
    expect(plan.receivedAtFrom).toBe("2026-06-01T00:00:00Z");
    expect(plan.receivedAtTo).toBe("2026-06-03T00:00:00Z");
  });

  it("expands replay-suffixed ids for delivery_attempts / route_evaluations / rollups", () => {
    const plan = buildErasurePlan("ws_1", matches);
    const da = plan.clickhouse.find((s) => s.table === "delivery_attempts")!;
    expect(da.statement).toContain("match(event_id, '^(evt_a|evt_b)#rpy_')");
    expect(plan.clickhouse.map((s) => s.table)).toEqual(
      expect.arrayContaining(["delivery_attempts", "route_evaluations", "delivery_latest_outcomes", "delivery_base_latest_outcomes"]),
    );
  });

  it("uses each table's OWN time column and a LOWER bound for delivery/eval (deliveries occur after ingest)", () => {
    const plan = buildErasurePlan("ws_1", matches);
    const da = plan.clickhouse.find((s) => s.table === "delivery_attempts")!;
    const re = plan.clickhouse.find((s) => s.table === "route_evaluations")!;
    // delivery_attempts.created_at — lower bound only (with skew margin), never an
    // (ingest-time) upper bound.
    expect(da.statement).toContain("toDate(created_at) >= toDate('2026-06-01') - 1");
    expect(da.statement).not.toMatch(/BETWEEN/);
    // route_evaluations.evaluated_at — NOT created_at (which doesn't exist there).
    expect(re.statement).toContain("toDate(evaluated_at) >= toDate('2026-06-01') - 1");
    expect(re.statement).not.toContain("created_at");
  });

  it("matches replay-suffixed ids in the delivery_idempotency Postgres delete", () => {
    const plan = buildErasurePlan("ws_1", matches);
    const di = plan.postgres.find((s) => s.table === "delivery_idempotency")!;
    expect(di.statement).toContain("split_part(event_id, '#', 1) = ANY($2)");
  });

  it("workspace-pins Postgres deletes by event_id (no ClickHouse-only base_event_id), and discloses out-of-scope stores", () => {
    const plan = buildErasurePlan("ws_1", matches);
    expect(plan.postgres.map((s) => s.table)).toEqual([
      "data_contract_fixtures",
      "data_contract_drift_events",
      "dead_letters",
      "replay_requests",
      "delivery_idempotency",
      "erasure_subjects",
    ]);
    const replayStmt = plan.postgres.find((s) => s.table === "replay_requests")!.statement;
    expect(replayStmt).toContain("event_id = ANY($2)");
    // base_event_id does not exist in Postgres replay_requests — must never appear,
    // or every erasure execution 42703-errors and replay rows survive.
    expect(replayStmt).not.toContain("base_event_id");
    expect(plan.r2.knownKeys).toEqual(["events/ws_1/2026-06-01/evt_a", "events/ws_1/2026-06-03/evt_b"]);
    // Only queue-spill is a real derived family (deliveries/ never existed).
    expect(plan.r2.derivedAtExecute.length).toBe(1);
    expect(plan.r2.derivedAtExecute[0]).toMatch(/queue-spill/);
    expect(plan.outOfScope.length).toBeGreaterThan(0);
  });

  it("produces an empty plan for no matches", () => {
    const plan = buildErasurePlan("ws_1", []);
    expect(plan.clickhouse).toEqual([]);
    expect(plan.postgres).toEqual([]);
    expect(plan.eventIds).toEqual([]);
  });

  it("escapes RE2 metacharacters in the replay-match regex (no injection via a dotted id)", () => {
    const plan = buildErasurePlan("ws_1", [
      { event_id: "a.b:c", r2_key: null, received_at: "2026-06-01T00:00:00Z" },
    ]);
    const da = plan.clickhouse.find((s) => s.table === "delivery_attempts")!;
    // The '.' is escaped so it matches literally, not as an "any char" metachar.
    expect(da.statement).toContain("(a\\.b:c)#rpy_");
    expect(da.statement).not.toContain("(a.b:c)#rpy_");
  });
});

describe("executeErasure", () => {
  const matches = [{ event_id: "evt_a", r2_key: "events/ws_1/2026-06-01/evt_a", received_at: "2026-06-01T00:00:00Z" }];

  const ENABLED_ENV = {
    ERASURE_EXECUTE_ENABLED: "true",
    CLOUDFLARE_R2_API_TOKEN: "tok",
    CLOUDFLARE_ACCOUNT_ID: "acc",
  };

  // ClickHouse fake: returns one delivery_attempts row for the spill-key
  // reconstruction SELECT, and an empty result for the ALTER mutations.
  function fakeClickhouse(calls: string[]) {
    return sharedFakeClickhouse({
      responses: (sql) => {
        calls.push(sql);
        return /SELECT DISTINCT event_id/.test(sql)
          ? [{ event_id: "evt_a", destination_id: "dst_1", attempt_no: 0 }]
          : [];
      },
    }).client;
  }

  it("dry-runs with zero mutations when the gate is off (default)", async () => {
    const res = await executeErasure("ws_1", matches, { env: {} });
    expect(res.dryRun).toBe(true);
    expect(res.executeEnabled).toBe(false);
    expect(res.mutationsIssued).toBe(0);
    expect(res.storeResults).toEqual([]);
    expect(res.deletionManifestHash).toBeNull();
    expect(res.plan.eventIds).toEqual(["evt_a"]);
  });

  it("dry-runs when the gate is on but there are no matched events", async () => {
    const res = await executeErasure("ws_1", [], { env: ENABLED_ENV });
    expect(res.dryRun).toBe(true);
    expect(res.mutationsIssued).toBe(0);
  });

  it("executes across R2 + ClickHouse + Postgres when the gate is on", async () => {
    const chCalls: string[] = [];
    const deletedKeys: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      deletedKeys.push(decodeURIComponent(String(url).split("/objects/")[1] ?? ""));
      return new Response("", { status: 200 });
    });
    const pgCalls: Array<{ sql: string; params: unknown[] }> = [];
    const query: Queryable = {
      async query(sql: string, params: unknown[] = []) {
        pgCalls.push({ sql, params });
        return { rows: [], rowCount: 3 };
      },
    };

    const res = await executeErasure("ws_1", matches, {
      env: ENABLED_ENV,
      clickhouse: fakeClickhouse(chCalls),
      query,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.dryRun).toBe(false);
    expect(res.executeEnabled).toBe(true);

    // R2: the known events/ key AND the reconstructed queue-spill key were deleted.
    expect(deletedKeys).toContain("events/ws_1/2026-06-01/evt_a");
    expect(deletedKeys).toContain("queue-spill/ws_1/evt_a/dst_1/0.json");

    // ClickHouse: the partition-pruned ALTER mutations were issued.
    expect(chCalls.some((s) => /ALTER TABLE events DELETE/.test(s))).toBe(true);
    expect(chCalls.some((s) => /ALTER TABLE delivery_attempts DELETE/.test(s))).toBe(true);

    // Postgres: workspace-pinned deletes ran with [workspace, eventIds].
    expect(pgCalls.some((c) => /DELETE FROM dead_letters/.test(c.sql))).toBe(true);
    expect(pgCalls.every((c) => c.params[0] === "ws_1")).toBe(true);

    // Audit: per-store results + a deletion manifest hash.
    expect(res.storeResults.find((s) => s.store === "r2:axel-events-raw")?.status).toBe("deleted");
    expect(res.storeResults.some((s) => s.store === "clickhouse:events" && s.status === "deleted")).toBe(true);
    expect(res.storeResults.some((s) => s.store === "postgres:dead_letters" && s.count === 3)).toBe(true);
    // All stores clean → the subject→event index is deleted too.
    expect(res.storeResults.some((s) => s.store === "postgres:erasure_subjects" && s.status === "deleted")).toBe(true);
    expect(res.deletionManifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retains the erasure_subjects index (skipped) when a store fails, so the erasure is retryable", async () => {
    // ClickHouse answers the spill SELECT but throws on every ALTER → CH stores fail.
    const ch = {
      async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        if (/SELECT DISTINCT event_id/.test(sql)) {
          return { rows: [{ event_id: "evt_a", destination_id: "dst_1", attempt_no: 0 }] as unknown as T[] };
        }
        throw new Error("Code: 47");
      },
    };
    const deletedTables: string[] = [];
    const query: Queryable = {
      async query(sql: string) {
        deletedTables.push(sql);
        return { rows: [], rowCount: 1 };
      },
    };
    const res = await executeErasure("ws_1", matches, {
      env: ENABLED_ENV,
      clickhouse: ch,
      query,
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });

    // Data deletes still ran (fault isolation), but the index was NOT deleted —
    // it's retained so the failed erasure can be re-found and retried.
    expect(deletedTables.some((s) => /DELETE FROM dead_letters/.test(s))).toBe(true);
    expect(deletedTables.some((s) => /DELETE FROM erasure_subjects/.test(s))).toBe(false);
    const idx = res.storeResults.find((s) => s.store === "postgres:erasure_subjects");
    expect(idx?.status).toBe("skipped");
  });

  it("records a failed store and KEEPS GOING (Postgres still runs; audit preserved)", async () => {
    // ClickHouse that throws on every ALTER but answers the spill SELECT.
    const ch = {
      async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        if (/SELECT DISTINCT event_id/.test(sql)) {
          return { rows: [{ event_id: "evt_a", destination_id: "dst_1", attempt_no: 0 }] as unknown as T[] };
        }
        throw new Error("Code: 47. UNKNOWN_IDENTIFIER");
      },
    };
    let pgRan = false;
    const query: Queryable = {
      async query() {
        pgRan = true;
        return { rows: [], rowCount: 2 };
      },
    };

    const res = await executeErasure("ws_1", matches, {
      env: ENABLED_ENV,
      clickhouse: ch,
      query,
      fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
    });

    // Every ClickHouse store recorded 'failed', but Postgres still ran...
    expect(res.storeResults.filter((s) => s.status === "failed").length).toBeGreaterThan(0);
    expect(pgRan).toBe(true);
    expect(res.storeResults.some((s) => s.store === "postgres:dead_letters" && s.status === "deleted")).toBe(true);
    // ...and the manifest hash is still computed so the audit isn't lost.
    expect(res.deletionManifestHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to execute an event id that doesn't match the system-generated shape (injection guard)", async () => {
    const evil = [{ event_id: "evt_a' OR '1'='1", r2_key: null, received_at: "2026-06-01T00:00:00Z" }];
    await expect(
      executeErasure("ws_1", evil, { env: ENABLED_ENV, clickhouse: fakeClickhouse([]) }),
    ).rejects.toThrow(/erasure_unsafe_event_id/);
  });

  it("reconstructs ALL queue-spill keys for a high-volume subject (>10k attempts) with no truncation", async () => {
    // Regression: the spill-key reconstruction SELECT must run on an UNBOUNDED
    // ClickHouse client. The default client caps results at 10k rows
    // (result_overflow_mode=break), which would silently leave queue-spill PII
    // un-erased for a subject with >10k delivery attempts while still reporting R2
    // "deleted". The fake returns 12,500 distinct attempt rows; every one of them
    // must be reconstructed into an R2 key and deleted.
    const ROWS = 12_500;
    const ch = {
      async query<T = Record<string, unknown>>(sql: string): Promise<{ rows: T[] }> {
        if (/SELECT DISTINCT event_id/.test(sql)) {
          const rows = Array.from({ length: ROWS }, (_, i) => ({
            event_id: "evt_a",
            destination_id: `dst_${i}`,
            attempt_no: 0,
          }));
          return { rows: rows as unknown as T[] };
        }
        return { rows: [] };
      },
    };
    const deletedKeys: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL) => {
      deletedKeys.push(decodeURIComponent(String(url).split("/objects/")[1] ?? ""));
      return new Response("", { status: 200 });
    });
    const query: Queryable = {
      async query() {
        return { rows: [], rowCount: 0 };
      },
    };

    const res = await executeErasure("ws_1", matches, {
      env: ENABLED_ENV,
      clickhouse: ch,
      query,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.dryRun).toBe(false);
    // The known events/ key + all 12,500 reconstructed queue-spill keys.
    const spillKeys = deletedKeys.filter((k) => k.startsWith("queue-spill/"));
    expect(spillKeys).toHaveLength(ROWS);
    expect(spillKeys).toContain("queue-spill/ws_1/evt_a/dst_0/0.json");
    expect(spillKeys).toContain(`queue-spill/ws_1/evt_a/dst_${ROWS - 1}/0.json`);
    // Audit detail records the full count (no cap at 10k).
    expect(res.storeResults.find((s) => s.store === "r2:axel-events-raw")?.detail).toContain(`${ROWS} queue-spill/`);
  });
});
