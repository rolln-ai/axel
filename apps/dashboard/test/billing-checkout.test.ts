import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  createCheckoutSession,
  createPortalSession,
  reconcileCompletedCheckout,
} from "../lib/billing/checkout";
import type { Queryable } from "../lib/db";

function makeFakeStripe(): {
  stripe: Pick<Stripe, "customers" | "checkout" | "billingPortal">;
  calls: {
    customers: Array<{ email?: string; metadata?: Record<string, string> }>;
    checkout: Array<Stripe.Checkout.SessionCreateParams>;
    portal: Array<Stripe.BillingPortal.SessionCreateParams>;
  };
} {
  const calls = {
    customers: [] as Array<{ email?: string; metadata?: Record<string, string> }>,
    checkout: [] as Array<Stripe.Checkout.SessionCreateParams>,
    portal: [] as Array<Stripe.BillingPortal.SessionCreateParams>,
  };
  const stripe = {
    customers: {
      async create(arg: { email?: string; metadata?: Record<string, string> }) {
        calls.customers.push(arg);
        return { id: `cus_${calls.customers.length}` };
      },
    },
    checkout: {
      sessions: {
        async create(arg: Stripe.Checkout.SessionCreateParams) {
          calls.checkout.push(arg);
          return { id: "cs_1", url: "https://checkout.stripe.com/c/cs_1" };
        },
      },
    },
    billingPortal: {
      sessions: {
        async create(arg: Stripe.BillingPortal.SessionCreateParams) {
          calls.portal.push(arg);
          return { id: "bps_1", url: "https://billing.stripe.com/p/session/bps_1" };
        },
      },
    },
  } as unknown as Pick<Stripe, "customers" | "checkout" | "billingPortal">;
  return { stripe, calls };
}

function makeFakePg(opts: { existingCustomerId?: string | null } = {}): {
  pg: Queryable;
  updates: Array<{ sql: string; params: unknown[] }>;
} {
  const updates: Array<{ sql: string; params: unknown[] }> = [];
  const pg: Queryable = {
    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      if (/SELECT stripe_customer_id FROM workspaces/.test(sql)) {
        return {
          rows: [{ stripe_customer_id: opts.existingCustomerId ?? null }] as unknown as T[],
          rowCount: 1,
        };
      }
      updates.push({ sql, params });
      return { rows: [] as unknown as T[], rowCount: 0 };
    },
  };
  return { pg, updates };
}

describe("createCheckoutSession", () => {
  beforeEach(() => {
    process.env.STRIPE_PRICE_BASE_ID = "price_base";
    process.env.STRIPE_PRICE_METER_ID = "price_meter";
  });
  afterEach(() => {
    delete process.env.STRIPE_PRICE_BASE_ID;
    delete process.env.STRIPE_PRICE_METER_ID;
  });

  it("creates a customer on first upgrade and persists the id", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg, updates } = makeFakePg({ existingCustomerId: null });
    const result = await createCheckoutSession(
      {
        workspaceId: "ws_a",
        userEmail: "owner@example.com",
        successUrl: "https://app.axelapp.ai/settings?tab=billing&checkout=success",
        cancelUrl: "https://app.axelapp.ai/settings?tab=billing&checkout=cancel",
      },
      { stripe, pg },
    );
    expect(result.url).toBe("https://checkout.stripe.com/c/cs_1");
    expect(calls.customers).toEqual([
      { email: "owner@example.com", metadata: { workspace_id: "ws_a" } },
    ]);
    const persistUpdate = updates.find((u) =>
      /UPDATE workspaces SET stripe_customer_id/.test(u.sql),
    );
    expect(persistUpdate?.params).toEqual(["ws_a", "cus_1"]);
  });

  it("reuses an existing stripe_customer_id rather than creating a duplicate", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg({ existingCustomerId: "cus_existing" });
    await createCheckoutSession(
      {
        workspaceId: "ws_a",
        userEmail: "owner@example.com",
        successUrl: "https://app.axelapp.ai/x",
        cancelUrl: "https://app.axelapp.ai/y",
      },
      { stripe, pg },
    );
    expect(calls.customers).toHaveLength(0);
    expect(calls.checkout[0]?.customer).toBe("cus_existing");
  });

  it("subscribes both the flat base and metered overage prices", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg({ existingCustomerId: "cus_a" });
    await createCheckoutSession(
      {
        workspaceId: "ws_a",
        userEmail: "owner@example.com",
        successUrl: "x",
        cancelUrl: "y",
      },
      { stripe, pg },
    );
    expect(calls.checkout[0]?.mode).toBe("subscription");
    expect(calls.checkout[0]?.line_items).toEqual([
      { price: "price_base", quantity: 1 },
      { price: "price_meter" },
    ]);
    expect(calls.checkout[0]?.subscription_data?.metadata).toEqual({ workspace_id: "ws_a" });
    expect(calls.checkout[0]?.client_reference_id).toBe("ws_a");
  });

  it("throws when STRIPE_PRICE_BASE_ID is unset", async () => {
    delete process.env.STRIPE_PRICE_BASE_ID;
    const { stripe } = makeFakeStripe();
    const { pg } = makeFakePg({ existingCustomerId: "cus_a" });
    await expect(
      createCheckoutSession(
        { workspaceId: "ws_a", userEmail: "x@y", successUrl: "x", cancelUrl: "y" },
        { stripe, pg },
      ),
    ).rejects.toThrow(/STRIPE_PRICE_BASE_ID/);
  });
});

describe("createPortalSession", () => {
  it("refuses when workspace has no stripe_customer_id", async () => {
    const { stripe } = makeFakeStripe();
    const { pg } = makeFakePg({ existingCustomerId: null });
    await expect(
      createPortalSession(
        { workspaceId: "ws_a", returnUrl: "https://app.axelapp.ai/settings?tab=billing" },
        { stripe, pg },
      ),
    ).rejects.toThrow(/upgrade first/);
  });

  it("returns the portal URL when the customer exists", async () => {
    const { stripe, calls } = makeFakeStripe();
    const { pg } = makeFakePg({ existingCustomerId: "cus_a" });
    const result = await createPortalSession(
      { workspaceId: "ws_a", returnUrl: "https://app.axelapp.ai/settings?tab=billing" },
      { stripe, pg },
    );
    expect(result.url).toBe("https://billing.stripe.com/p/session/bps_1");
    expect(calls.portal[0]?.customer).toBe("cus_a");
    expect(calls.portal[0]?.return_url).toBe("https://app.axelapp.ai/settings?tab=billing");
  });
});

describe("reconcileCompletedCheckout", () => {
  function subscription(customer = "cus_a"): Stripe.Subscription {
    return {
      id: "sub_a",
      object: "subscription",
      customer,
      status: "active",
      items: {
        data: [
          {
            current_period_start: 1716000000,
            current_period_end: 1718592000,
          },
        ],
      },
    } as unknown as Stripe.Subscription;
  }

  function reconcileDeps(opts: {
    workspaceCustomer?: string;
    checkoutWorkspace?: string;
    checkoutCustomer?: string;
    expanded?: boolean;
  } = {}) {
    const updates: Array<{ sql: string; params: unknown[] }> = [];
    const retrievedSubscriptions: string[] = [];
    const sub = subscription(opts.checkoutCustomer ?? "cus_a");
    const pg: Queryable = {
      async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
        if (/SELECT stripe_customer_id FROM workspaces/.test(sql)) {
          return {
            rows: [{ stripe_customer_id: opts.workspaceCustomer ?? "cus_a" }] as unknown as T[],
            rowCount: 1,
          };
        }
        updates.push({ sql, params });
        return { rows: [] as unknown as T[], rowCount: 1 };
      },
    };
    const stripe = {
      checkout: {
        sessions: {
          async retrieve() {
            return {
              id: "cs_a",
              status: "complete",
              client_reference_id: opts.checkoutWorkspace ?? "ws_a",
              customer: opts.checkoutCustomer ?? "cus_a",
              subscription: opts.expanded === false ? "sub_a" : sub,
            };
          },
        },
      },
      subscriptions: {
        async retrieve(id: string) {
          retrievedSubscriptions.push(id);
          return sub;
        },
      },
    } as unknown as Pick<Stripe, "checkout" | "subscriptions">;
    return { pg, stripe, updates, retrievedSubscriptions };
  }

  it("synchronizes the completed subscription before the webhook arrives", async () => {
    const { pg, stripe, updates } = reconcileDeps();
    await reconcileCompletedCheckout(
      { workspaceId: "ws_a", checkoutSessionId: "cs_a" },
      { pg, stripe },
    );
    const update = updates.find((q) => /SET plan = 'pro'/.test(q.sql));
    expect(update?.params).toEqual([
      "cus_a",
      "sub_a",
      "ok",
      new Date(1716000000 * 1000),
      new Date(1718592000 * 1000),
    ]);
  });

  it("retrieves the subscription when Checkout does not return an expanded object", async () => {
    const { pg, stripe, retrievedSubscriptions } = reconcileDeps({ expanded: false });
    await reconcileCompletedCheckout(
      { workspaceId: "ws_a", checkoutSessionId: "cs_a" },
      { pg, stripe },
    );
    expect(retrievedSubscriptions).toEqual(["sub_a"]);
  });

  it("rejects a Checkout Session belonging to another workspace", async () => {
    const { pg, stripe, updates } = reconcileDeps({ checkoutWorkspace: "ws_other" });
    await expect(
      reconcileCompletedCheckout(
        { workspaceId: "ws_a", checkoutSessionId: "cs_other" },
        { pg, stripe },
      ),
    ).rejects.toThrow("checkout_workspace_mismatch");
    expect(updates).toHaveLength(0);
  });

  it("rejects a Checkout customer that does not match the active workspace", async () => {
    const { pg, stripe, updates } = reconcileDeps({ checkoutCustomer: "cus_other" });
    await expect(
      reconcileCompletedCheckout(
        { workspaceId: "ws_a", checkoutSessionId: "cs_other" },
        { pg, stripe },
      ),
    ).rejects.toThrow("checkout_customer_mismatch");
    expect(updates).toHaveLength(0);
  });
});
