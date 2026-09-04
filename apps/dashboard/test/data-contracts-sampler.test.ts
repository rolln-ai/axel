import { describe, expect, it, vi } from "vitest";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import {
  extractEventTypeFromBody,
  extractEventTypeFromHeaders,
  extractEventTypeFromValue,
} from "@axel/shared";
import {
  countSourceEvents,
  countDistinctEventTypes,
  sampleByEventTypeIndex,
  sampleSourceEvents,
  sampleSourceEventsPreferIndex,
  SamplerPayloadFetchError,
  shapeHash,
} from "../lib/data-contracts/sampler";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

type Row = {
  event_id: string;
  source_id: string;
  r2_key: string;
  // Matches the CandidateRow contract in sampler.ts. Named distinctly
  // from the underlying ClickHouse `received_at` column to avoid the
  // alias-shadowing bug that bit prod.
  received_at_text: string;
  shard: number;
  size_bytes: number;
  headers_json: string;
  day_offset: number;
};

function ch(rows: Row[]): ClickhouseQueryable {
  return {
    async query<T>() {
      return { rows: rows as unknown as T[] };
    },
  };
}

/**
 * Capturing client that records the exact SQL sent to ClickHouse.
 * Used for regression tests that verify the generated query shape
 * (e.g. correct column usage + alias ordering for dateDiff vs toString).
 */
function capturingCh(rows: Row[]) {
  let lastSql = "";
  const client: ClickhouseQueryable & { getLastSql: () => string } = {
    async query<T>(sql: string) {
      lastSql = sql;
      return { rows: rows as unknown as T[] };
    },
    getLastSql: () => lastSql,
  };
  return client;
}

function row(over: Partial<Row>): Row {
  return {
    event_id: "evt_x",
    source_id: "src_1",
    r2_key: "shard-0/evt_x.json",
    received_at_text: "2026-05-15 00:00:00.000",
    shard: 0,
    size_bytes: 1024,
    headers_json: "{}",
    day_offset: 0,
    ...over,
  };
}

describe("shapeHash", () => {
  it("returns the same hash for payloads with the same nested keys regardless of value or key order", () => {
    const a = { id: "x", customer: { email: "a@b.com", phone: "+1" }, n: 1 };
    const b = { n: 999, customer: { phone: "+9", email: "z@y.com" }, id: "y" };
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it("distinguishes payloads with different shapes", () => {
    const a = { id: "x", amount: 1 };
    const b = { id: "x", amount: "1" };
    expect(shapeHash(a)).not.toBe(shapeHash(b));
  });

  it("collapses arrays of like-shaped elements via [0]-only recursion", () => {
    const a = { data: [{ id: "1" }, { id: "2" }, { id: "3" }] };
    const b = { data: [{ id: "Z" }] };
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it("distinguishes top-level shape from nested-array shape", () => {
    const a = { id: "x" };
    const b = { data: { id: "x" } };
    expect(shapeHash(a)).not.toBe(shapeHash(b));
  });
});

describe("extractEventType (shared, used by ingest index + inference)", () => {
  it("picks the first present discriminator key in priority order", () => {
    expect(extractEventTypeFromValue({ type: "a", event: "b" })).toBe("a");
    expect(extractEventTypeFromValue({ event: "subscriber.opened_email" })).toBe(
      "subscriber.opened_email",
    );
    expect(extractEventTypeFromValue({ action: "x", topic: "y" })).toBe("x");
  });

  it("returns null for non-objects, arrays, missing/oversized values", () => {
    expect(extractEventTypeFromValue(null)).toBeNull();
    expect(extractEventTypeFromValue([{ type: "a" }])).toBeNull();
    expect(extractEventTypeFromValue({ id: "x" })).toBeNull();
    // 81 chars is over the (inclusive) 80-char cap → dropped.
    expect(extractEventTypeFromValue({ type: "x".repeat(81) })).toBeNull();
    expect(extractEventTypeFromValue({ type: "" })).toBeNull();
  });

  it("accepts a type name of exactly the max length (80 inclusive), rejects 81", () => {
    // Regression: the cap was strict `<` so an exactly-80-char name was silently
    // dropped. It is now inclusive — body AND header paths.
    const exactly80 = "x".repeat(80);
    const over81 = "x".repeat(81);
    expect(extractEventTypeFromValue({ type: exactly80 })).toBe(exactly80);
    expect(extractEventTypeFromValue({ type: over81 })).toBeNull();
    expect(extractEventTypeFromHeaders({ "x-event-type": exactly80 })).toBe(exactly80);
    expect(extractEventTypeFromHeaders({ "x-event-type": over81 })).toBeNull();
  });

  it("extractEventTypeFromBody returns '' for non-JSON / untyped, never throws", () => {
    expect(extractEventTypeFromBody(new TextEncoder().encode("not json"))).toBe("");
    expect(extractEventTypeFromBody(enc({ id: "x" }))).toBe("");
    expect(extractEventTypeFromBody(enc({ type: "invoice.paid" }))).toBe("invoice.paid");
  });

  it("falls back to common event-type headers when the body has none", () => {
    // Case-insensitive, priority-ordered.
    expect(extractEventTypeFromHeaders({ "x-github-event": "push" })).toBe("push");
    expect(extractEventTypeFromHeaders({ "X-Shopify-Topic": "orders/create" })).toBe(
      "orders/create",
    );
    expect(extractEventTypeFromHeaders({ "x-event-type": "a", "x-github-event": "b" })).toBe("a");
    expect(extractEventTypeFromHeaders({ "x-irrelevant": "z" })).toBeNull();
    expect(extractEventTypeFromHeaders(undefined)).toBeNull();
  });

  it("body wins over header, header used only as fallback", () => {
    const headers = { "x-github-event": "issues" };
    // Body has a discriminator → body wins.
    expect(extractEventTypeFromBody(enc({ type: "ping" }), headers)).toBe("ping");
    // Body has none (non-JSON or no key) → header fills in.
    expect(extractEventTypeFromBody(enc({ id: "x" }), headers)).toBe("issues");
    expect(extractEventTypeFromBody(new TextEncoder().encode("<xml/>"), headers)).toBe("issues");
  });

  it("counts codepoints, not UTF-16 code units, against the max-length cap", () => {
    // Regression: `.length` counts UTF-16 code units and astral-plane
    // characters (emoji) take two each, so a short emoji-bearing
    // discriminator over 40 chars was silently dropped into the untyped ''
    // bucket. The guard now counts codepoints — consistently for the body
    // AND header paths.
    const emoji45 = "🎉".repeat(45); // 90 code units, 45 codepoints → accept
    expect(extractEventTypeFromValue({ type: emoji45 })).toBe(emoji45);
    expect(extractEventTypeFromHeaders({ "x-event-type": emoji45 })).toBe(emoji45);
    const emoji80 = "🎉".repeat(80); // 160 units, exactly 80 codepoints (inclusive cap)
    expect(extractEventTypeFromValue({ type: emoji80 })).toBe(emoji80);
    expect(extractEventTypeFromHeaders({ "x-event-type": emoji80 })).toBe(emoji80);
    const emoji81 = "🎉".repeat(81); // 81 codepoints → over the cap either way
    expect(extractEventTypeFromValue({ type: emoji81 })).toBeNull();
    expect(extractEventTypeFromHeaders({ "x-event-type": emoji81 })).toBeNull();
  });

  it("derives candidate types independently of producer egress policy", () => {
    // Ingest applies a stricter boundary after this helper: only signed named
    // providers may publish a bounded canonical type. Admin, pull, and custom
    // events stay untyped. This locks the pure extraction primitive used by
    // inference without implying that every caller may persist its result.
    const stamp = (bytes: Uint8Array, headers?: Record<string, string>) => {
      const eventType = extractEventTypeFromBody(bytes, headers);
      return { is_test: true, ...(eventType ? { event_type: eventType } : {}) };
    };
    expect(stamp(enc({ type: "invoice.paid" }))).toEqual({
      is_test: true,
      event_type: "invoice.paid",
    });
    expect(stamp(enc({ id: "x" }), { "x-github-event": "push" })).toEqual({
      is_test: true,
      event_type: "push",
    });
    // No discriminator anywhere → field omitted, not "".
    expect(stamp(enc({ id: "x" }))).toEqual({ is_test: true });
  });
});

describe("sampleByEventTypeIndex (exhaustive distinct-by-type)", () => {
  function typedCh(rows: Array<Record<string, unknown>>) {
    let lastSql = "";
    const client = {
      async query<T>(sql: string) {
        lastSql = sql;
        return { rows: rows as unknown as T[] };
      },
      getLastSql: () => lastSql,
    };
    return client;
  }

  function typedRow(event_type: string, n: number) {
    return {
      event_type,
      event_id: `${event_type}_${n}`,
      r2_key: `${event_type}/${n}`,
      received_at_text: "2026-06-10 00:00:00.000",
      shard: 0,
      size_bytes: 100,
      headers_json: "{}",
    };
  }

  it("returns one SampledEvent per CH row and queries DISTINCT-by-type", async () => {
    const client = typedCh([
      typedRow("subscriber.opened_email", 1),
      typedRow("subscriber.applied_tag", 1),
      typedRow("subscriber.bounced_email", 1),
    ]);
    const out = await sampleByEventTypeIndex("ws_1", "src_1", {
      clickhouseClient: client,
      fetchPayload: async (k) => ({ event: k.split("/")[0] }),
    });
    expect(out).not.toBeNull();
    expect(out!.map((e) => e.event_id).sort()).toEqual([
      "subscriber.applied_tag_1",
      "subscriber.bounced_email_1",
      "subscriber.opened_email_1",
    ]);
    const sql = client.getLastSql();
    expect(sql).toMatch(/LIMIT\s+\{per_type:UInt32\}\s+BY\s+event_type/);
  });

  it("returns null when CH has no rows at all (empty / un-backfilled source)", async () => {
    const out = await sampleByEventTypeIndex("ws_1", "src_1", {
      clickhouseClient: typedCh([]),
      fetchPayload: async () => ({ type: "x" }),
    });
    expect(out).toBeNull();
  });

  it("returns null when EVERY row is untyped, so the richer shape sampler runs instead", async () => {
    const out = await sampleByEventTypeIndex("ws_1", "src_1", {
      clickhouseClient: typedCh([typedRow("", 1), typedRow("", 2)]),
      fetchPayload: async () => ({ id: "x" }),
    });
    expect(out).toBeNull();
  });

  it("keeps untyped events as their own bucket when the source is mixed", async () => {
    // One real type + some untyped events: the untyped ones must NOT be
    // dropped — inference will sub-cluster them by shape.
    const out = await sampleByEventTypeIndex("ws_1", "src_1", {
      clickhouseClient: typedCh([
        typedRow("invoice.paid", 1),
        typedRow("", 1),
        typedRow("", 2),
      ]),
      fetchPayload: async (k) => ({ k }),
    });
    expect(out).not.toBeNull();
    expect(out!.map((e) => e.event_id).sort()).toEqual([
      "_1",
      "_2",
      "invoice.paid_1",
    ]);
  });

  it("returns null when the column doesn't exist yet (query throws)", async () => {
    const client = {
      async query<T>(): Promise<{ rows: T[] }> {
        throw new Error("Unknown identifier 'event_type'");
      },
    };
    const out = await sampleByEventTypeIndex("ws_1", "src_1", {
      clickhouseClient: client,
      fetchPayload: async () => ({ type: "x" }),
    });
    expect(out).toBeNull();
  });

  it("returns null when every R2 fetch fails so the caller can fall back", async () => {
    const out = await sampleByEventTypeIndex("ws_1", "src_1", {
      clickhouseClient: typedCh([typedRow("a", 1), typedRow("b", 1)]),
      fetchPayload: async () => null,
    });
    expect(out).toBeNull();
  });

  it("warns when distinct types reach maxTypes (truncation is observable)", async () => {
    // 3 distinct types with maxTypes=3 → at the cap → must warn.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await sampleByEventTypeIndex("ws_1", "src_1", {
        maxTypes: 3,
        clickhouseClient: typedCh([typedRow("a", 1), typedRow("b", 1), typedRow("c", 1)]),
        fetchPayload: async (k) => ({ event: k.split("/")[0] }),
      });
      expect(out).not.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/event-type index returned 3 distinct types/);
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn when distinct types are below maxTypes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await sampleByEventTypeIndex("ws_1", "src_1", {
        maxTypes: 10,
        clickhouseClient: typedCh([typedRow("a", 1), typedRow("b", 1)]),
        fetchPayload: async (k) => ({ event: k.split("/")[0] }),
      });
      expect(out).not.toBeNull();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  // Rollout/backfill hardening: the moment ANY row in the window is typed,
  // `LIMIT {per_type} BY event_type` collapses a partially-backfilled legacy
  // backlog (event_type='') into a single perTypeSamples-capped bucket —
  // ~12 samples standing in for potentially millions of rows. When the ''
  // bucket hits its cap, the index sampler must delegate it to the legacy
  // hash-distributed shape sampler (restricted to untyped rows) so schema
  // inference still sees the backlog's diversity during the rollout window.
  describe("untyped legacy-backlog delegation (mixed typed/untyped windows)", () => {
    /** CH fake that serves the LIMIT-BY index query and the untyped-only legacy pool separately. */
    function mixedCh(indexRows: Array<Record<string, unknown>>, untypedPool: Row[]) {
      const sqls: string[] = [];
      const client = {
        async query<T>(sql: string) {
          sqls.push(sql);
          if (/LIMIT\s+\{per_type:UInt32\}\s+BY\s+event_type/.test(sql)) {
            return { rows: indexRows as unknown as T[] };
          }
          return { rows: untypedPool as unknown as T[] };
        },
        getSqls: () => sqls,
      };
      return client;
    }

    function typedRow(event_type: string, n: number) {
      return {
        event_type,
        event_id: `${event_type}_${n}`,
        r2_key: `${event_type}/${n}`,
        received_at_text: "2026-08-20 00:00:00.000",
        shard: 0,
        size_bytes: 100,
        headers_json: "{}",
      };
    }

    // Distinct shape per key so neither sampler's dedup drops anything.
    const distinctShapes = async (k: string) => ({ [k]: 1 });

    it("delegates a cap-saturated '' bucket to the untyped-only legacy sampler", async () => {
      // perTypeSamples=3 and exactly 3 '' rows → the bucket hit its cap, so
      // the window's untyped backlog may be arbitrarily larger. The legacy
      // pool has 6 distinct-shape rows; ALL of them must reach the output,
      // replacing the 3 capped '' rows.
      const client = mixedCh(
        [
          typedRow("invoice.paid", 1),
          typedRow("", 1),
          typedRow("", 2),
          typedRow("", 3),
        ],
        Array.from({ length: 6 }, (_, i) => row({ event_id: `legacy${i}`, r2_key: `kl${i}` })),
      );
      const out = await sampleByEventTypeIndex("ws_1", "src_1", {
        perTypeSamples: 3,
        clickhouseClient: client,
        fetchPayload: distinctShapes,
      });
      expect(out).not.toBeNull();
      const ids = out!.map((e) => e.event_id).sort();
      expect(ids).toEqual([
        "invoice.paid_1",
        "legacy0",
        "legacy1",
        "legacy2",
        "legacy3",
        "legacy4",
        "legacy5",
      ]);
      // The supplement query is the legacy hash-distributed sampler,
      // restricted to the untyped bucket.
      const sqls = client.getSqls();
      expect(sqls).toHaveLength(2);
      expect(sqls[1]).toContain("AND event_type = ''");
      expect(sqls[1]).toMatch(/ORDER BY\s+cityHash64\(event_id\)/);
    });

    it("does NOT run the supplement when the '' bucket is below its cap (already exhaustive)", async () => {
      // 2 untyped rows with perTypeSamples=3: LIMIT BY didn't truncate
      // anything — every untyped event in the window is already in the
      // sample, so a second query would be pure waste.
      const client = mixedCh(
        [typedRow("invoice.paid", 1), typedRow("", 1), typedRow("", 2)],
        [row({ event_id: "legacy0", r2_key: "kl0" })],
      );
      const out = await sampleByEventTypeIndex("ws_1", "src_1", {
        perTypeSamples: 3,
        clickhouseClient: client,
        fetchPayload: distinctShapes,
      });
      expect(out).not.toBeNull();
      expect(out!.map((e) => e.event_id).sort()).toEqual(["_1", "_2", "invoice.paid_1"]);
      expect(client.getSqls()).toHaveLength(1);
    });

    it("keeps the capped '' rows when the supplement comes back empty", async () => {
      const client = mixedCh(
        [typedRow("invoice.paid", 1), typedRow("", 1), typedRow("", 2), typedRow("", 3)],
        [],
      );
      const out = await sampleByEventTypeIndex("ws_1", "src_1", {
        perTypeSamples: 3,
        clickhouseClient: client,
        fetchPayload: distinctShapes,
      });
      expect(out).not.toBeNull();
      expect(out!.map((e) => e.event_id).sort()).toEqual([
        "_1",
        "_2",
        "_3",
        "invoice.paid_1",
      ]);
    });

    it("keeps the capped '' rows when the supplement query throws (best-effort)", async () => {
      let calls = 0;
      const client = {
        async query<T>(sql: string): Promise<{ rows: T[] }> {
          calls++;
          if (/LIMIT\s+\{per_type:UInt32\}\s+BY\s+event_type/.test(sql)) {
            return {
              rows: [
                typedRow("invoice.paid", 1),
                typedRow("", 1),
                typedRow("", 2),
                typedRow("", 3),
              ] as unknown as T[],
            };
          }
          throw new Error("CH blip");
        },
      };
      const out = await sampleByEventTypeIndex("ws_1", "src_1", {
        perTypeSamples: 3,
        clickhouseClient: client,
        fetchPayload: distinctShapes,
      });
      expect(calls).toBe(2);
      expect(out).not.toBeNull();
      expect(out!.map((e) => e.event_id).sort()).toEqual([
        "_1",
        "_2",
        "_3",
        "invoice.paid_1",
      ]);
    });
  });

  it("sampleSourceEventsPreferIndex uses the index when populated, else random sampler", async () => {
    // Index populated → used.
    const indexed = await sampleSourceEventsPreferIndex(
      "ws_1",
      "src_1",
      {},
      {
        clickhouseClient: typedCh([typedRow("a", 1)]),
        fetchPayload: async () => ({ type: "a" }),
      },
    );
    expect(indexed.map((e) => e.event_id)).toEqual(["a_1"]);

    // Index empty → falls back to the random sampler (different CH client).
    const fellBack = await sampleSourceEventsPreferIndex(
      "ws_1",
      "src_1",
      {
        clickhouseClient: ch([row({ event_id: "rnd1", r2_key: "kr1" })]),
        fetchPayload: async () => ({ type: "z" }),
      },
      { clickhouseClient: typedCh([]), fetchPayload: async () => ({}) },
    );
    expect(fellBack.map((e) => e.event_id)).toEqual(["rnd1"]);
  });
});

describe("sampleSourceEvents", () => {
  it("returns [] when ClickHouse has no rows for the source", async () => {
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch([]),
      fetchPayload: async () => ({}),
    });
    expect(out).toEqual([]);
  });

  it("keeps multiple events of the same shape, up to perShapeSampleLimit", async () => {
    // 4 events with the same shape. Per-shape limit defaults to 20, so
    // all 4 should be kept — inference needs multiple samples per
    // cluster to compute real uniqueness / presence / enum stats.
    const rows = [
      row({ event_id: "e1", r2_key: "k1" }),
      row({ event_id: "e2", r2_key: "k2" }),
      row({ event_id: "e3", r2_key: "k3" }),
      row({ event_id: "e4", r2_key: "k4" }),
    ];
    const payloads: Record<string, unknown> = {
      k1: { id: "1", amount: 1 },
      k2: { id: "2", amount: 2 },
      k3: { id: "3", amount: 3 },
      k4: { id: "4", amount: 4 },
    };
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
    });
    expect(out).toHaveLength(4);
    expect(out.map((e) => e.event_id).sort()).toEqual(["e1", "e2", "e3", "e4"]);
  });

  it("trims to perShapeSampleLimit when one shape dominates", async () => {
    const rows: Row[] = [];
    const payloads: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      rows.push(row({ event_id: `e${i}`, r2_key: `k${i}` }));
      payloads[`k${i}`] = { id: String(i), amount: i };
    }
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
      perShapeSampleLimit: 5,
    });
    expect(out).toHaveLength(5);
    // We keep the FIRST N — matches "most recent first" ordering since
    // the candidate query returns received_at DESC.
    expect(out.map((e) => e.event_id)).toEqual(["e0", "e1", "e2", "e3", "e4"]);
  });

  it("keeps samples from each distinct shape independently of the per-shape limit", async () => {
    const rows = [
      row({ event_id: "a1", r2_key: "ka1" }),
      row({ event_id: "a2", r2_key: "ka2" }),
      row({ event_id: "b1", r2_key: "kb1" }),
      row({ event_id: "b2", r2_key: "kb2" }),
      row({ event_id: "b3", r2_key: "kb3" }),
    ];
    const payloads: Record<string, unknown> = {
      // shape A: 2 events
      ka1: { type: "invoice.paid", id: "x" },
      ka2: { type: "invoice.paid", id: "y" },
      // shape B: 3 events (extra `refund` field)
      kb1: { type: "invoice.refunded", id: "z", refund: { amount: 100 } },
      kb2: { type: "invoice.refunded", id: "w", refund: { amount: 200 } },
      kb3: { type: "invoice.refunded", id: "v", refund: { amount: 300 } },
    };
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
      perShapeSampleLimit: 5,
    });
    expect(out).toHaveLength(5);
    expect(out.map((e) => e.event_id).sort()).toEqual([
      "a1",
      "a2",
      "b1",
      "b2",
      "b3",
    ]);
  });

  it("does NOT apply a per-day cap by default, so high-volume older days keep their rare types", async () => {
    // Synthetic high-volume regression: a newsletter source with 500,000
    // events across 10 days showed a Data Contract with only 2 event types.
    // The old default decay budget (perDayBudgetToday=50, halving) trimmed
    // the hash-distributed candidate pool to ~100 and gave the BIGGEST day
    // (5+ days back, half of all traffic) a budget of 2 — dropping the rare
    // types that lived there. With the budget now opt-in, every candidate
    // survives the trim and distinct shapes are surfaced.
    const rows: Row[] = [];
    const payloads: Record<string, unknown> = {};
    // 10 distinct event types, each on a different "old" day (offset 5..14),
    // i.e. exactly where the old decay budget collapsed to the floor.
    for (let i = 0; i < 10; i++) {
      rows.push(row({ event_id: `t${i}`, r2_key: `k${i}`, day_offset: 5 + i }));
      payloads[`k${i}`] = { type: `evt.type_${i}`, id: String(i) };
    }
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
    });
    expect(out).toHaveLength(10);
    expect(out.map((e) => e.event_id).sort()).toEqual(
      ["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9"].sort(),
    );
  });

  it("trims older days using the decay budget", async () => {
    // Each payload's shape is intentionally distinct (different key sets)
    // so the dedup pass doesn't drop them — we want this test to exercise
    // the per-day budget, not the dedup.
    const rows = [
      row({ event_id: "today1", r2_key: "t1", day_offset: 0 }),
      row({ event_id: "today2", r2_key: "t2", day_offset: 0 }),
      row({ event_id: "today3", r2_key: "t3", day_offset: 0 }),
      row({ event_id: "old1", r2_key: "o1", day_offset: 10 }),
      row({ event_id: "old2", r2_key: "o2", day_offset: 10 }),
    ];
    const payloads: Record<string, unknown> = {
      t1: { a: 1 },
      t2: { b: 1 },
      t3: { c: 1 },
      o1: { d: 1 },
      o2: { e: 1 },
    };
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
      perDayBudgetToday: 2,
      perDayBudgetFloor: 1,
    });
    // Day 0: budget=2 → 2 kept. Day 10: budget=floor(2/2^10)=0 → floor=1 → 1 kept.
    expect(out.map((e) => e.event_id).sort()).toEqual([
      "old1",
      "today1",
      "today2",
    ]);
  });

  it("respects maxEvents cap", async () => {
    const rows: Row[] = [];
    const payloads: Record<string, unknown> = {};
    for (let i = 0; i < 20; i++) {
      rows.push(row({ event_id: `e${i}`, r2_key: `k${i}` }));
      // Distinct shape per payload — only the cap should decide cutoff.
      payloads[`k${i}`] = { [`field_${i}`]: 1 };
    }
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
      maxEvents: 3,
    });
    expect(out).toHaveLength(3);
  });

  it("respects maxBytes cap (keeps at least the first event)", async () => {
    const rows = [
      row({ event_id: "big1", r2_key: "b1", size_bytes: 4 * 1024 * 1024 }),
      row({ event_id: "big2", r2_key: "b2", size_bytes: 4 * 1024 * 1024 }),
    ];
    const payloads: Record<string, unknown> = {
      b1: { a: 1 },
      b2: { b: 1 },
    };
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
      maxBytes: 5 * 1024 * 1024,
    });
    expect(out.map((e) => e.event_id)).toEqual(["big1"]);
  });

  it("throws SamplerPayloadFetchError when creds are absent and every R2 fetch returns null", async () => {
    // Prod regression: when CLOUDFLARE_R2_API_TOKEN was empty,
    // fetchPayloadForR2Key fell back to GENERIC_SAMPLE for every event,
    // producing a fake `payment_intent.succeeded` cluster on a synthetic
    // newsletter source with 800,000 events. After the fix, null returns mean
    // "couldn't read R2" and — WHEN CREDS ARE MISSING — the sampler must
    // escalate so refresh.ts can show "fix your R2 creds" instead of "no
    // events yet".
    const rows = [
      row({ event_id: "e1", r2_key: "k1" }),
      row({ event_id: "e2", r2_key: "k2" }),
      row({ event_id: "e3", r2_key: "k3" }),
    ];
    await expect(
      sampleSourceEvents("ws_1", "src_1", {
        clickhouseClient: ch(rows),
        fetchPayload: async () => null,
        r2CredsPresent: false,
      }),
    ).rejects.toBeInstanceOf(SamplerPayloadFetchError);
  });

  it("returns [] (no throw) when creds ARE present but every payload is unreadable", async () => {
    // Retention-swept payloads: ClickHouse metadata outlives the R2 raw
    // payloads (swept as early as ~7 days), so a low-traffic source can draw
    // candidates whose payloads no longer exist. With creds present this is
    // benign — the sampler must NOT misreport it as a creds failure (that
    // was the source of spurious "check your Cloudflare token" Sentry alerts).
    const rows = [
      row({ event_id: "e1", r2_key: "k1" }),
      row({ event_id: "e2", r2_key: "k2" }),
      row({ event_id: "e3", r2_key: "k3" }),
    ];
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async () => null,
      r2CredsPresent: true,
    });
    expect(out).toEqual([]);
  });

  it("returns [] without throwing when CH has no rows (no R2 fetches attempted)", async () => {
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch([]),
      fetchPayload: async () => null,
    });
    expect(out).toEqual([]);
  });

  it("skips rows whose R2 fetch throws or returns null", async () => {
    const rows = [
      row({ event_id: "ok1", r2_key: "k1" }),
      row({ event_id: "bad", r2_key: "missing" }),
      row({ event_id: "nullp", r2_key: "kn" }),
      row({ event_id: "ok2", r2_key: "k2" }),
    ];
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => {
        if (k === "missing") throw new Error("not found");
        if (k === "kn") return null;
        // Distinct shapes so dedup doesn't drop the second OK row.
        return k === "k1" ? { ok1: true } : { ok2: true };
      },
    });
    expect(out.map((e) => e.event_id)).toEqual(["ok1", "ok2"]);
  });

  it("does not expose historical headers_json through sampled events", async () => {
    const rows = [
      row({
        event_id: "e1",
        r2_key: "k1",
        headers_json: '{"content-type":"application/json","x-foo":"bar"}',
      }),
    ];
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async () => ({ ok: true }),
    });
    expect(out[0]!.headers).toEqual({});
  });

  it("survives malformed headers_json", async () => {
    const rows = [
      row({ event_id: "e1", r2_key: "k1", headers_json: "not-json" }),
    ];
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async () => ({ ok: true }),
    });
    expect(out[0]!.headers).toEqual({});
  });

  // Regression for a production-shaped ClickHouse type failure:
  //   Code: 43. illegal type for dateDiff's 2nd argument 'startdate': got String.
  //
  // Root cause: the SELECT had `toString(received_at) AS received_at`,
  // which (because ClickHouse resolves SELECT-list aliases GLOBALLY, not
  // left-to-right) shadowed the underlying DateTime64 column for every
  // other expression in the list, including dateDiff. Putting dateDiff
  // first in the SELECT does NOT fix this — only renaming the alias
  // does. This test asserts the alias is renamed so we can't regress.
  it("does not alias the toString(received_at) result back to the column name", async () => {
    const client = capturingCh([row({ event_id: "e1", r2_key: "k1" })]);
    await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: client,
      fetchPayload: async () => ({ test: true }),
      maxEvents: 1,
    });

    const sql = client.getLastSql();
    expect(sql).toContain("dateDiff('day', received_at, now()) AS day_offset");
    // The toString result MUST use a distinct alias so the raw column
    // stays bound for dateDiff.
    expect(sql).not.toMatch(/toString\(received_at\)\s+AS\s+received_at\b/);
    expect(sql).toMatch(/toString\(received_at\)\s+AS\s+received_at_text\b/);
  });

  // Synthetic skew regression: a payment source with 20 event types and
  // 95% `payment_intent.succeeded` was sampled into
  // a Data Contract with just 1 cluster, because the previous newest-first
  // candidate pull was saturated with the dominant shape and never saw
  // the long tail. Two protections now keep diversity:
  //   1. ClickHouse ordering is hash-distributed, not time-DESC.
  //   2. When a candidate's shape is already saturated, the fetch is NOT
  //      counted against `maxFetches` — so dominant-shape duplicates
  //      can't starve the rest of the pool.
  it("orders the candidate query by hash, not received_at, so rare types aren't crowded out", async () => {
    const client = capturingCh([row({ event_id: "e1", r2_key: "k1" })]);
    await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: client,
      fetchPayload: async () => ({ test: true }),
      maxEvents: 1,
    });
    const sql = client.getLastSql();
    expect(sql).toMatch(/ORDER BY\s+cityHash64\(event_id\)/);
    expect(sql).not.toMatch(/ORDER BY\s+received_at\s+DESC/);
  });

  it("does not let a dominant shape exhaust the fetch budget when rarer shapes are present", async () => {
    // 19 events of the dominant shape, then 1 rare event with a distinct
    // shape, all within the candidate set. With perShapeSampleLimit=5
    // and maxFetches=10, the OLD sampler would burn all 10 fetches on
    // the dominant shape (keeping only 5, dropping 5) and never reach
    // the rare event. The new sampler treats saturated-shape fetches
    // as "free" so it keeps scanning until it finds the rare shape.
    const rows: Row[] = [];
    const payloads: Record<string, unknown> = {};
    for (let i = 0; i < 19; i++) {
      rows.push(row({ event_id: `dom${i}`, r2_key: `kd${i}` }));
      // Same shape for every dominant event.
      payloads[`kd${i}`] = { type: "payment_intent.succeeded", id: String(i) };
    }
    rows.push(row({ event_id: "rare", r2_key: "krare" }));
    payloads["krare"] = { type: "invoice.refunded", id: "R", refund_amount: 1 };

    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => payloads[k],
      perShapeSampleLimit: 5,
      maxEvents: 50,
      maxFetches: 10,
    });
    const ids = out.map((e) => e.event_id);
    expect(ids).toContain("rare");
    // Dominant shape capped at 5.
    expect(ids.filter((id) => id.startsWith("dom"))).toHaveLength(5);
  });

  it("countSourceEvents returns the CH count and adds a since-filter only when requested", async () => {
    let lastSql = "";
    const client: ClickhouseQueryable = {
      async query<T>(sql: string) {
        lastSql = sql;
        return { rows: [{ n: "475170" }] as unknown as T[] };
      },
    };
    const total = await countSourceEvents("ws_1", "src_1", { clickhouseClient: client });
    expect(total).toBe(475170);
    expect(lastSql).not.toContain("received_at > {since:String}");

    const since = await countSourceEvents("ws_1", "src_1", {
      clickhouseClient: client,
      sinceIso: "2026-06-06T22:00:34.545Z",
    });
    expect(since).toBe(475170);
    expect(lastSql).toContain("received_at > {since:String}");
  });

  it("countSourceEvents returns 0 (never throws) when ClickHouse errors", async () => {
    const client: ClickhouseQueryable = {
      async query<T>(): Promise<{ rows: T[] }> {
        throw new Error("CH down");
      },
    };
    expect(
      await countSourceEvents("ws_1", "src_1", { clickhouseClient: client }),
    ).toBe(0);
  });

  it("stops early when many consecutive candidates all map to saturated shapes", async () => {
    // 200 same-shape events. With perShapeSampleLimit=3, we keep 3 and
    // skip the rest. The early-stop window (64) means we shouldn't
    // fetch all 200 R2 objects — that was the OLD waste pattern.
    const rows: Row[] = [];
    const payloads: Record<string, unknown> = {};
    let fetchCount = 0;
    for (let i = 0; i < 200; i++) {
      rows.push(row({ event_id: `e${i}`, r2_key: `k${i}` }));
      payloads[`k${i}`] = { type: "x", id: String(i) };
    }
    const out = await sampleSourceEvents("ws_1", "src_1", {
      clickhouseClient: ch(rows),
      fetchPayload: async (k) => {
        fetchCount++;
        return payloads[k];
      },
      perShapeSampleLimit: 3,
      maxEvents: 50,
      fetchConcurrency: 8,
    });
    expect(out).toHaveLength(3);
    // 3 kept + 64-window early-stop + last wave rounding. Plenty
    // smaller than the full 200 the old sampler would have done.
    expect(fetchCount).toBeLessThan(100);
  });
});

describe("countDistinctEventTypes (stale-schema guard)", () => {
  function capturingCh(rows: Array<Record<string, unknown>>) {
    let lastSql = "";
    const client: ClickhouseQueryable & { getLastSql: () => string } = {
      async query<T>(sql: string) {
        lastSql = sql;
        return { rows: rows as unknown as T[] };
      },
      getLastSql: () => lastSql,
    };
    return client;
  }

  it("returns the distinct typed-type count and excludes the untyped bucket", async () => {
    const ch = capturingCh([{ n: "22" }]);
    const out = await countDistinctEventTypes("ws_1", "src_1", { clickhouseClient: ch });
    expect(out).toBe(22);
    expect(ch.getLastSql()).toMatch(/uniqExactIf\(event_type, event_type != ''\)/);
  });

  it("returns 0 when CH errors (column missing pre-migration / blip) so the check no-ops", async () => {
    const throwingCh = {
      async query() {
        throw new Error("Missing columns: 'event_type'");
      },
    } as unknown as ClickhouseQueryable;
    expect(await countDistinctEventTypes("ws_1", "src_1", { clickhouseClient: throwingCh })).toBe(0);
  });

  it("returns 0 when CH returns no rows", async () => {
    expect(
      await countDistinctEventTypes("ws_1", "src_1", { clickhouseClient: capturingCh([]) }),
    ).toBe(0);
  });
});
