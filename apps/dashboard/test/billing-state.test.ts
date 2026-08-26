import { describe, expect, it } from "vitest";
import {
  estimateInvoiceCents,
  loadWorkspaceBillingState,
  type WorkspaceBillingState,
} from "../lib/billing/state";
import type { Queryable } from "../lib/db";

function makePg(opts: {
  workspaceRow?: Record<string, unknown>;
  invoices?: Array<Record<string, unknown>>;
}): Queryable {
  const invoices = opts.invoices ?? [];
  return {
    async query<T = Record<string, unknown>>(sql: string) {
      if (/FROM workspaces w/.test(sql)) {
        return {
          rows: opts.workspaceRow ? ([opts.workspaceRow] as unknown as T[]) : ([] as unknown as T[]),
          rowCount: opts.workspaceRow ? 1 : 0,
        };
      }
      if (/FROM billing_invoices/.test(sql)) {
        return { rows: invoices as unknown as T[], rowCount: invoices.length };
      }
      return { rows: [] as unknown as T[], rowCount: 0 };
    },
  };
}

describe("loadWorkspaceBillingState", () => {
  it("returns zero usage when no usage_period row exists yet", async () => {
    const pg = makePg({
      workspaceRow: {
        plan: "free",
        billing_status: "ok",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        billing_period_start: null,
        billing_period_end: null,
        ingest_tasks: null,
        delivery_tasks: null,
        reported_to_stripe_at: null,
      },
    });
    const state = await loadWorkspaceBillingState("ws_a", pg);
    expect(state.plan).toBe("free");
    expect(state.tasksThisPeriod).toBe(0);
    expect(state.recentInvoices).toEqual([]);
  });

  it("defaults billingExempt to false when the row omits it", async () => {
    const pg = makePg({
      workspaceRow: {
        plan: "free",
        billing_status: "ok",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        billing_period_start: null,
        billing_period_end: null,
        ingest_tasks: null,
        delivery_tasks: null,
        reported_to_stripe_at: null,
      },
    });
    const state = await loadWorkspaceBillingState("ws_a", pg);
    expect(state.billingExempt).toBe(false);
  });

  it("surfaces billing_exempt so the banner/panel can suppress false gate notices", async () => {
    const pg = makePg({
      workspaceRow: {
        plan: "free",
        billing_status: "suspended",
        billing_exempt: true,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        billing_period_start: null,
        billing_period_end: null,
        ingest_tasks: "50000",
        delivery_tasks: null,
        reported_to_stripe_at: null,
      },
    });
    const state = await loadWorkspaceBillingState("ws_a", pg);
    expect(state.billingExempt).toBe(true);
    expect(state.tasksThisPeriod).toBe(50_000);
  });

  it("passes through admin-set enterprise plans with no Stripe objects", async () => {
    const pg = makePg({
      workspaceRow: {
        plan: "enterprise",
        billing_status: "ok",
        billing_exempt: false,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        billing_period_start: null,
        billing_period_end: null,
        ingest_tasks: "2000000",
        delivery_tasks: null,
        reported_to_stripe_at: null,
      },
    });
    const state = await loadWorkspaceBillingState("ws_a", pg);
    expect(state.plan).toBe("enterprise");
    expect(state.billingExempt).toBe(false);
    expect(state.stripeCustomerId).toBeNull();
    expect(state.stripeSubscriptionId).toBeNull();
  });

  it("uses inbound ingest only for metered usage", async () => {
    const pg = makePg({
      workspaceRow: {
        plan: "pro",
        billing_status: "ok",
        stripe_customer_id: "cus_a",
        stripe_subscription_id: "sub_a",
        billing_period_start: new Date("2026-05-01T00:00:00Z"),
        billing_period_end: new Date("2026-06-01T00:00:00Z"),
        ingest_tasks: "300000",
        delivery_tasks: "200000",
        reported_to_stripe_at: new Date("2026-05-20T01:00:00Z"),
      },
    });
    const state = await loadWorkspaceBillingState("ws_a", pg);
    expect(state.tasksThisPeriod).toBe(300_000);
  });

  it("throws when workspace doesn't exist", async () => {
    const pg = makePg({});
    await expect(loadWorkspaceBillingState("ws_missing", pg)).rejects.toThrow(
      /not found/,
    );
  });

  it("returns invoices in payload-friendly shape", async () => {
    const pg = makePg({
      workspaceRow: {
        plan: "pro",
        billing_status: "ok",
        stripe_customer_id: "cus_a",
        stripe_subscription_id: "sub_a",
        billing_period_start: null,
        billing_period_end: null,
        ingest_tasks: "0",
        delivery_tasks: "0",
        reported_to_stripe_at: null,
      },
      invoices: [
        {
          id: "in_a",
          status: "paid",
          total_cents: 2000,
          currency: "usd",
          period_start: new Date("2026-05-01T00:00:00Z"),
          period_end: new Date("2026-06-01T00:00:00Z"),
          hosted_url: "https://invoice/in_a",
          pdf_url: null,
          created_at: new Date("2026-05-15T00:00:00Z"),
        },
      ],
    });
    const state = await loadWorkspaceBillingState("ws_a", pg);
    expect(state.recentInvoices[0]).toMatchObject({
      id: "in_a",
      status: "paid",
      totalCents: 2000,
      hostedUrl: "https://invoice/in_a",
      pdfUrl: null,
    });
  });
});

describe("estimateInvoiceCents", () => {
  function makeState(plan: "free" | "pro" | "enterprise", tasks: number): WorkspaceBillingState {
    return {
      plan,
      billingStatus: "ok",
      billingExempt: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      billingPeriodStart: null,
      billingPeriodEnd: null,
      currentPeriodStart: "2026-05-01",
      tasksThisPeriod: tasks,
      reportedToStripeAt: null,
      recentInvoices: [],
    };
  }

  it("returns 0 for free plan regardless of tasks", () => {
    expect(estimateInvoiceCents(makeState("free", 9_500))).toBe(0);
    expect(estimateInvoiceCents(makeState("free", 100_000))).toBe(0);
  });

  it("returns flat $20.00 for Pro under the included threshold", () => {
    expect(estimateInvoiceCents(makeState("pro", 0))).toBe(2000);
    expect(estimateInvoiceCents(makeState("pro", 1_333_333))).toBe(2000);
  });

  it("adds overage at $0.015/1k above the credit threshold", () => {
    // 100,000 events over → $1.50 → $21.50
    expect(estimateInvoiceCents(makeState("pro", 1_333_333 + 100_000))).toBe(2150);
    // 5M inbound events cost $75 in total.
    expect(estimateInvoiceCents(makeState("pro", 5_000_000))).toBe(7500);
  });

  it("ceil-rounds partial overage to whole cents", () => {
    expect(estimateInvoiceCents(makeState("pro", 1_333_334))).toBe(2001);
    expect(estimateInvoiceCents(makeState("pro", 1_334_000))).toBe(2001);
  });
});
