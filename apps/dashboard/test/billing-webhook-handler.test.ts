import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { processStripeWebhook } from "../lib/billing/webhook-handler";
import type { Queryable } from "../lib/db";

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

function makeFakePg(opts: {
  duplicateEventId?: string;
  workspaceByCustomer?: Record<string, string>;
  /**
   * processed_at for an already-journaled event id, returned by the
   * `SELECT processed_at FROM billing_events` lookup. A value means "fully
   * processed → true duplicate"; null means "prior attempt failed mid-apply
   * → should re-apply on retry". Defaults to a non-null timestamp.
   */
  priorEvents?: Record<string, { processed_at: string | null }>;
} = {}): { pg: Queryable; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const pg: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      // billing_events INSERT … ON CONFLICT DO NOTHING RETURNING id
      if (/INSERT INTO billing_events/i.test(sql)) {
        const eventId = String(params[0]);
        if (opts.duplicateEventId === eventId) {
          return { rows: [] as unknown as T[], rowCount: 0 };
        }
        return {
          rows: [{ id: eventId }] as unknown as T[],
          rowCount: 1,
        };
      }
      // Idempotency follow-up: SELECT processed_at after an INSERT conflict.
      if (/SELECT processed_at FROM billing_events/.test(sql)) {
        const eventId = String(params[0]);
        const entry = opts.priorEvents?.[eventId];
        const processed_at = entry ? entry.processed_at : "2026-05-20T00:00:00.000Z";
        return { rows: [{ processed_at }] as unknown as T[], rowCount: 1 };
      }
      // workspace lookup by stripe_customer_id
      if (/FROM workspaces WHERE stripe_customer_id/.test(sql)) {
        const customer = String(params[0]);
        const wsId = opts.workspaceByCustomer?.[customer];
        return {
          rows: wsId ? ([{ id: wsId }] as unknown as T[]) : ([] as unknown as T[]),
          rowCount: wsId ? 1 : 0,
        };
      }
      return { rows: [] as unknown as T[], rowCount: 0 };
    },
  };
  return { pg, queries };
}

function makeEvent(
  type: Stripe.Event.Type | string,
  data: object,
  overrides: Partial<Stripe.Event> = {},
): Stripe.Event {
  return {
    id: overrides.id ?? `evt_${Math.random().toString(36).slice(2, 10)}`,
    type: type as Stripe.Event.Type,
    api_version: "2026-04-22.dahlia",
    created: 1716200000,
    data: { object: data as Stripe.Event.Data["object"] },
    livemode: false,
    pending_webhooks: 0,
    request: null,
    object: "event",
    ...overrides,
  } as Stripe.Event;
}

describe("processStripeWebhook", () => {
  it("stores no Stripe event or customer metadata in the idempotency journal", async () => {
    const { pg, queries } = makeFakePg({ workspaceByCustomer: { cus_sensitive: "ws_a" } });
    await processStripeWebhook(
      makeEvent(
        "customer.subscription.created",
        {
          id: "sub_sensitive",
          customer: "cus_sensitive",
          customer_email: "private@example.test",
          metadata: { private_marker: "must-not-persist" },
          status: "active",
          current_period_start: 1716000000,
          current_period_end: 1718592000,
        },
        { id: "evt_sensitive" },
      ),
      { pg },
    );

    const journalInsert = queries.find((query) => /INSERT INTO billing_events/.test(query.sql));
    expect(journalInsert?.sql).toContain("'{}'::jsonb");
    expect(journalInsert?.sql).not.toContain("$4::jsonb");
    expect(journalInsert?.params).toEqual([
      "evt_sensitive",
      "customer.subscription.created",
      "ws_a",
    ]);
    expect(JSON.stringify(journalInsert?.params)).not.toContain("cus_sensitive");
    expect(JSON.stringify(journalInsert?.params)).not.toContain("private@example.test");
    expect(JSON.stringify(journalInsert?.params)).not.toContain("must-not-persist");
  });

  it("returns alreadySeen=true and skips state changes on PK conflict", async () => {
    const { pg, queries } = makeFakePg({ duplicateEventId: "evt_dup" });
    const event = makeEvent(
      "customer.subscription.created",
      { id: "sub_x", customer: "cus_x", status: "active", current_period_start: 0, current_period_end: 0 },
      { id: "evt_dup" },
    );
    const result = await processStripeWebhook(event, { pg });
    expect(result.alreadySeen).toBe(true);
    expect(result.processed).toBe(false);
    // No UPDATE workspaces call should follow a duplicate INSERT.
    const updates = queries.filter((q) => /UPDATE workspaces/.test(q.sql));
    expect(updates).toHaveLength(0);
  });

  it("re-applies an incomplete prior attempt (processed_at IS NULL) on Stripe retry", async () => {
    // A prior delivery failed mid-apply: the billing_events row exists but
    // processed_at was left NULL. Stripe retries the same event id; the handler
    // must re-run the state change instead of skipping it as a duplicate.
    const { pg, queries } = makeFakePg({
      duplicateEventId: "evt_retry",
      workspaceByCustomer: { cus_a: "ws_a" },
      priorEvents: { evt_retry: { processed_at: null } },
    });
    const result = await processStripeWebhook(
      makeEvent(
        "customer.subscription.created",
        {
          id: "sub_a",
          customer: "cus_a",
          status: "active",
          current_period_start: 1716000000,
          current_period_end: 1718592000,
        },
        { id: "evt_retry" },
      ),
      { pg },
    );
    expect(result.alreadySeen).toBe(false);
    expect(result.processed).toBe(true);
    // The subscription UPDATE must run on the retry — the state was NOT dropped.
    const upd = queries.find((q) => /UPDATE workspaces/.test(q.sql) && /plan = 'pro'/.test(q.sql));
    expect(upd).toBeDefined();
  });

  it("activates Pro plan and mirrors the billing period on subscription.created", async () => {
    const { pg, queries } = makeFakePg({
      workspaceByCustomer: { cus_a: "ws_a" },
    });
    await processStripeWebhook(
      makeEvent("customer.subscription.created", {
        id: "sub_a",
        customer: "cus_a",
        status: "active",
        current_period_start: 1716000000,
        current_period_end: 1718592000,
      }),
      { pg },
    );
    const upd = queries.find((q) => /UPDATE workspaces/.test(q.sql) && /plan = 'pro'/.test(q.sql));
    expect(upd).toBeDefined();
    expect(upd?.params).toEqual([
      "cus_a",
      "sub_a",
      "ok",
      new Date(1716000000 * 1000),
      new Date(1718592000 * 1000),
    ]);
  });

  it("reads current_period_* from subscription.items[] when top-level fields are absent", async () => {
    const { pg, queries } = makeFakePg({ workspaceByCustomer: { cus_a: "ws_a" } });
    await processStripeWebhook(
      makeEvent("customer.subscription.created", {
        id: "sub_a",
        customer: "cus_a",
        status: "active",
        items: {
          data: [
            { current_period_start: 1716000000, current_period_end: 1718592000 },
          ],
        },
      }),
      { pg },
    );
    const upd = queries.find((q) => /UPDATE workspaces/.test(q.sql) && /plan = 'pro'/.test(q.sql));
    expect(upd?.params[3]).toEqual(new Date(1716000000 * 1000));
    expect(upd?.params[4]).toEqual(new Date(1718592000 * 1000));
  });

  it("flips billing_status to past_due when subscription.status = past_due", async () => {
    const { pg, queries } = makeFakePg({ workspaceByCustomer: { cus_a: "ws_a" } });
    await processStripeWebhook(
      makeEvent("customer.subscription.updated", {
        id: "sub_a",
        customer: "cus_a",
        status: "past_due",
        current_period_start: 1716000000,
        current_period_end: 1718592000,
      }),
      { pg },
    );
    const upd = queries.find((q) => /UPDATE workspaces/.test(q.sql) && /plan = 'pro'/.test(q.sql));
    expect(upd?.params[2]).toBe("past_due");
  });

  it("downgrades to free-OK (not canceled) on subscription.deleted so the free tier still ingests", async () => {
    const { pg, queries } = makeFakePg({ workspaceByCustomer: { cus_a: "ws_a" } });
    await processStripeWebhook(
      makeEvent("customer.subscription.deleted", {
        id: "sub_a",
        customer: "cus_a",
        status: "canceled",
      }),
      { pg },
    );
    const upd = queries.find((q) => /plan = 'free'/.test(q.sql));
    expect(upd).toBeDefined();
    expect(upd?.params).toEqual(["cus_a", "sub_a"]);
    // Graceful end-of-period downgrade must land on 'ok' — 'canceled' would make
    // deriveGate 402 every ingest for the now-free workspace with no recovery.
    expect(upd?.sql).toMatch(/billing_status = 'ok'/);
    expect(upd?.sql).not.toMatch(/billing_status = 'canceled'/);
  });

  it("upserts an invoice row + marks workspace past_due on invoice.payment_failed", async () => {
    const { pg, queries } = makeFakePg({ workspaceByCustomer: { cus_a: "ws_a" } });
    await processStripeWebhook(
      makeEvent("invoice.payment_failed", {
        id: "in_a",
        customer: "cus_a",
        status: "open",
        total: 2000,
        currency: "usd",
        period_start: 1716000000,
        period_end: 1718592000,
        hosted_invoice_url: "https://invoice.stripe.com/hosted/in_a",
        invoice_pdf: "https://invoice.stripe.com/pdf/in_a",
      }),
      { pg },
    );
    const inv = queries.find((q) => /INSERT INTO billing_invoices/.test(q.sql));
    expect(inv).toBeDefined();
    expect(inv?.params).toEqual([
      "in_a",
      "ws_a",
      "open",
      2000,
      "usd",
      new Date(1716000000 * 1000),
      new Date(1718592000 * 1000),
      "https://invoice.stripe.com/hosted/in_a",
      "https://invoice.stripe.com/pdf/in_a",
    ]);
    const upd = queries.find((q) => /billing_status = 'past_due'/.test(q.sql));
    expect(upd).toBeDefined();
  });

  it("upserts an invoice + clears past_due on invoice.paid", async () => {
    const { pg, queries } = makeFakePg({ workspaceByCustomer: { cus_a: "ws_a" } });
    await processStripeWebhook(
      makeEvent("invoice.paid", {
        id: "in_b",
        customer: "cus_a",
        status: "paid",
        total: 2000,
        currency: "usd",
      }),
      { pg },
    );
    const inv = queries.find((q) => /INSERT INTO billing_invoices/.test(q.sql));
    expect(inv?.params[2]).toBe("paid");
    // Recovery clears both dunning states — past_due AND a stale canceled — so a
    // re-subscription invoice unblocks a hard-canceled workspace too.
    const recovery = queries.find(
      (q) => /SET billing_status = 'ok'/.test(q.sql) && /billing_status IN \('past_due', 'canceled'\)/.test(q.sql),
    );
    expect(recovery).toBeDefined();
  });

  it("journals and no-ops unknown event types", async () => {
    const { pg, queries } = makeFakePg();
    const result = await processStripeWebhook(
      makeEvent("ping" as Stripe.Event.Type, {}),
      { pg },
    );
    expect(result.processed).toBe(true);
    const upd = queries.filter(
      (q) => /UPDATE workspaces/.test(q.sql) || /INSERT INTO billing_invoices/.test(q.sql),
    );
    expect(upd).toHaveLength(0);
  });
});
