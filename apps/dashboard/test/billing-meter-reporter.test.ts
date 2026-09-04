import { describe, expect, it } from "vitest";
import { fakeClickhouse } from "@axel/test-utils";
import type Stripe from "stripe";
import { reportMeterEvents } from "../lib/billing/meter-reporter";
import { publicBillingRollupCronSummary } from "../lib/billing/rollup";
import type { ClickhouseQueryable } from "../lib/clickhouse";
import type { Queryable } from "../lib/db";

interface MeterCall {
  event_name: string;
  identifier: string;
  payload: { stripe_customer_id: string; value: string };
  timestamp?: number;
}

function makeFakeStripe(opts: { failOn?: string } = {}): {
  stripe: Pick<Stripe, "billing">;
  calls: MeterCall[];
} {
  const calls: MeterCall[] = [];
  const stripe = {
    billing: {
      meterEvents: {
        async create(arg: MeterCall) {
          if (opts.failOn && arg.identifier.includes(opts.failOn)) {
            throw new Error("simulated stripe failure");
          }
          calls.push(arg);
          return arg;
        },
      },
    },
  } as unknown as Pick<Stripe, "billing">;
  return { stripe, calls };
}

function makeFakePg(rows: Array<{ id: string; stripe_customer_id: string | null }>): {
  pg: Queryable;
  updates: Array<{ sql: string; params: unknown[] }>;
} {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const pg: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (/FROM workspaces/.test(sql)) {
        return { rows: rows as unknown as T[], rowCount: rows.length };
      }
      updates.push({ sql, params });
      return { rows: [] as unknown as T[], rowCount: 0 };
    },
  };
  return { pg, updates };
}

function makeFakeCh(
  ingestByWs: Record<string, number>,
  deliveryByWs: Record<string, number>,
): ClickhouseQueryable {
  const toRows = (source: Record<string, number>) =>
    Object.entries(source).map(([workspace_id, tasks]) => ({
      workspace_id,
      tasks: String(tasks),
    }));
  // FIFO: the reporter queries ingest first.
  return fakeClickhouse({ responses: [toRows(ingestByWs), toRows(deliveryByWs)] }).client;
}

describe("reportMeterEvents", () => {
  const now = new Date("2026-05-15T03:00:00Z"); // yesterday = 2026-05-14

  it("pushes one Stripe meter event per Pro workspace with billable tasks", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg([
      { id: "ws_a", stripe_customer_id: "cus_a" },
      { id: "ws_b", stripe_customer_id: "cus_b" },
    ]);
    const ch = makeFakeCh({ ws_a: 100, ws_b: 50 }, { ws_a: 25 });

    const summary = await reportMeterEvents({ stripe, pg, ch, now });

    expect(summary.day).toBe("2026-05-14");
    expect(summary.reported).toBe(2);
    expect(summary.skipped).toBe(0);
    expect(summary.unbound).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_name: "axel_inbound_events",
          identifier: "ws_a:2026-05-14",
          payload: { stripe_customer_id: "cus_a", value: "100" },
        }),
        expect.objectContaining({
          event_name: "axel_inbound_events",
          identifier: "ws_b:2026-05-14",
          payload: { stripe_customer_id: "cus_b", value: "50" },
        }),
      ]),
    );
  });

  it("skips workspaces with zero billable tasks on the closed day", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg([{ id: "ws_a", stripe_customer_id: "cus_a" }]);
    const ch = makeFakeCh({}, {});
    const summary = await reportMeterEvents({ stripe, pg, ch, now });
    expect(summary.reported).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it("counts Pro workspaces without stripe_customer_id as unbound", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg([
      { id: "ws_unbound", stripe_customer_id: null },
      { id: "ws_a", stripe_customer_id: "cus_a" },
    ]);
    const ch = makeFakeCh({ ws_a: 10 }, {});
    const summary = await reportMeterEvents({ stripe, pg, ch, now });
    expect(summary.unbound).toBe(1);
    expect(summary.reported).toBe(1);
    expect(calls.find((c) => c.identifier.startsWith("ws_unbound:"))).toBeUndefined();
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: test name intentionally shows the literal identifier pattern
  it("uses identifier ${workspace}:${day} so re-runs deduplicate via Stripe", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg([{ id: "ws_a", stripe_customer_id: "cus_a" }]);
    const ch = makeFakeCh({ ws_a: 7 }, {});
    await reportMeterEvents({ stripe, pg, ch, now });
    const identifiers = calls.map((c) => c.identifier);
    expect(identifiers).toEqual(["ws_a:2026-05-14"]);
  });

  it("encodes wsList as a single-quoted ClickHouse Array(String) literal", async () => {
    // Regression: JSON.stringify produced ["a"] which ClickHouse rejected
    // with "expected opening quote ''', got '\"'" — must be ['a'] instead.
    const captured: Array<Record<string, string | number>> = [];
    const ch: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(_sql: string, params?: Record<string, string | number>) {
        if (params) captured.push(params);
        return { rows: [] as unknown as T[] };
      },
    };
    const { stripe } = makeFakeStripe();
    const { pg } = makeFakePg([
      { id: "ws_a", stripe_customer_id: "cus_a" },
      { id: "ws_o'reilly", stripe_customer_id: "cus_b" },
    ]);
    await reportMeterEvents({ stripe, pg, ch, now });
    expect(captured.length).toBeGreaterThan(0);
    const first = captured[0];
    if (!first) throw new Error("expected at least one captured query");
    const wsList = String(first.wsList);
    expect(wsList.startsWith("[")).toBe(true);
    expect(wsList.includes('"')).toBe(false);
    // The literal must single-quote each value and escape internal single quotes.
    expect(wsList).toContain("'ws_a'");
    expect(wsList).toContain("'ws_o\\'reilly'");
  });

  it("does not abort the run when one workspace fails Stripe push", async () => {
    const { stripe, calls } = makeFakeStripe({ failOn: "ws_bad" });
    const { pg } = makeFakePg([
      { id: "ws_good", stripe_customer_id: "cus_good" },
      { id: "ws_bad", stripe_customer_id: "cus_bad" },
    ]);
    const ch = makeFakeCh({ ws_good: 5, ws_bad: 9 }, {});
    const summary = await reportMeterEvents({ stripe, pg, ch, now });
    expect(summary.reported).toBe(1);
    expect(calls.map((c) => c.identifier)).toContain("ws_good:2026-05-14");
    // The failed workspace appears in events with a stable error tail.
    expect(summary.events.find((e) => e.workspaceId === "ws_bad")?.identifier).toMatch(/:error$/);
  });

  it("counts only deduped inbound events and never queries deliveries", async () => {
    // Regression: a Cloudflare-Queues at-least-once requeue can re-write a
    // duplicate ClickHouse row. count() would double-count it and push a higher
    // value to the (non-retractable) Stripe meter than the /usage dashboard
    // (lib/billing/rollup.ts) shows. Both queries must aggregate with uniqExact.
    const captured: string[] = [];
    const ch: ClickhouseQueryable = {
      async query<T = Record<string, unknown>>(sql: string) {
        captured.push(sql);
        return { rows: [] as unknown as T[] };
      },
    };
    const { stripe } = makeFakeStripe();
    const { pg } = makeFakePg([{ id: "ws_a", stripe_customer_id: "cus_a" }]);
    await reportMeterEvents({ stripe, pg, ch, now });

    const eventsSql = captured.find((s) => /FROM events/.test(s));
    const deliverySql = captured.find((s) => /FROM delivery_attempts/.test(s));
    if (!eventsSql) throw new Error("expected an events aggregation query");

    // events: uniqExact(event_id), never count().
    expect(eventsSql).toContain("uniqExact(event_id)");
    expect(eventsSql).not.toMatch(/count\(/i);

    expect(deliverySql).toBeUndefined();
  });
});

describe("publicBillingRollupCronSummary", () => {
  it("returns aggregate counts and fixed codes without tenant or provider identifiers", () => {
    const privateMarker = "private-workspace-provider-marker";
    const summary = publicBillingRollupCronSummary({
      summary: {
        periodStart: privateMarker,
        workspaceCount: 2,
        ingestTasks: 30,
        deliveryTasks: 40,
        durationMs: 50,
      },
      meter: {
        day: privateMarker,
        reported: 1,
        skipped: 2,
        unbound: 3,
        events: [
          { workspaceId: privateMarker, tasks: 4, identifier: privateMarker },
          { workspaceId: `${privateMarker}-failed`, tasks: 5, identifier: `${privateMarker}:error` },
        ],
      },
      planPush: { pushed: 6, errors: 1, skipped: 7 },
      emails: { sent: 8, alreadySent: 9, failed: 1, notificationsEmitted: 10 },
    });

    expect(summary.rollup.code).toBe("billing_rollup_completed");
    expect(summary.meter).toMatchObject({ reported: 1, failed: 1 });
    expect(summary.plan_push.code).toBe("plan_push_partial");
    expect(summary.emails.code).toBe("billing_email_partial");
    expect(JSON.stringify(summary)).not.toContain(privateMarker);
    expect(summary.meter).not.toHaveProperty("events");
  });
});
