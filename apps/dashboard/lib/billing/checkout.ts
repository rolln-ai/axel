import "server-only";
import type Stripe from "stripe";
import type { Queryable } from "../db";
import { db } from "../db";
import { stripeClient } from "./stripe-client";
import { applyStripeSubscription } from "./webhook-handler";

/**
 * Stripe Checkout + Customer Portal session helpers.
 *
 * A Pro upgrade flow:
 *   1. /settings?tab=billing posts to /api/billing/checkout
 *   2. createCheckoutSession() ensures the workspace has a
 *      stripe_customer_id (lazy-create + metadata.workspace_id), then
 *      returns a Stripe Checkout URL with both the $20 flat
 *      subscription price AND the metered overage price subscribed
 *      together.
 *   3. User pays. Stripe redirects to success_url. Stripe webhook
 *      fires customer.subscription.created → webhook-handler.ts
 *      flips workspace.plan='pro'.
 *
 * The Customer Portal handles card updates, invoice history, and
 * self-serve cancellation — no custom UI for those.
 */

export interface CheckoutInput {
  workspaceId: string;
  userEmail: string;
  /** Absolute URL Stripe redirects to on success. */
  successUrl: string;
  /** Absolute URL Stripe redirects to on cancel. */
  cancelUrl: string;
}

export interface PortalInput {
  workspaceId: string;
  /** Where the portal should send the user when they close it. */
  returnUrl: string;
}

export interface ReconcileCheckoutInput {
  workspaceId: string;
  checkoutSessionId: string;
}

export interface CheckoutDeps {
  stripe?: Pick<Stripe, "customers" | "checkout" | "billingPortal">;
  pg?: Queryable;
}

export interface ReconcileCheckoutDeps {
  stripe?: Pick<Stripe, "checkout" | "subscriptions">;
  pg?: Queryable;
}

/**
 * The workspace has no stripe_customer_id, so there is no portal session
 * to create. Expected for comped/admin-set plans (the plan-override panel
 * sets `plan` directly with no Stripe objects) — the portal route maps
 * this to a friendly 409 instead of a Sentry-captured 500.
 */
export class NoStripeCustomerError extends Error {
  constructor() {
    super("workspace has no Stripe customer — upgrade first");
    this.name = "NoStripeCustomerError";
  }
}

export async function createCheckoutSession(
  input: CheckoutInput,
  deps: CheckoutDeps = {},
): Promise<{ url: string }> {
  const baseSubscriptionPrice = requireEnv("STRIPE_PRICE_BASE_ID");
  const meteredPrice = requireEnv("STRIPE_PRICE_METER_ID");
  const pg = deps.pg ?? db();
  const stripe = deps.stripe ?? (stripeClient() as Pick<Stripe, "customers" | "checkout" | "billingPortal">);

  const customerId = await ensureCustomerId({
    workspaceId: input.workspaceId,
    userEmail: input.userEmail,
    stripe,
    pg,
  });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    // Both prices are subscribed together: the $20 flat base AND the
    // metered overage. The Stripe Price includes the first 1,333,333
    // inbound events, then bills accepted inbound events at $0.015/1k,
    // so the visible invoice line for low-volume workspaces is $0.
    line_items: [
      { price: baseSubscriptionPrice, quantity: 1 },
      { price: meteredPrice },
    ],
    subscription_data: {
      metadata: { workspace_id: input.workspaceId },
    },
    client_reference_id: input.workspaceId,
    allow_promotion_codes: true,
  });

  if (!session.url) {
    throw new Error("Stripe Checkout returned no session URL");
  }
  return { url: session.url };
}

export async function createPortalSession(
  input: PortalInput,
  deps: CheckoutDeps = {},
): Promise<{ url: string }> {
  const pg = deps.pg ?? db();
  const stripe = deps.stripe ?? (stripeClient() as Pick<Stripe, "customers" | "checkout" | "billingPortal">);

  const { rows } = await pg.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM workspaces WHERE id = $1 LIMIT 1`,
    [input.workspaceId],
  );
  const customerId = rows[0]?.stripe_customer_id;
  if (!customerId) {
    throw new NoStripeCustomerError();
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: input.returnUrl,
  });
  return { url: session.url };
}

/**
 * Close the Stripe redirect/webhook race.
 *
 * Stripe redirects the browser as soon as Checkout is complete, but its
 * customer.subscription.created webhook can arrive a moment later. On the
 * success return we retrieve the completed Checkout Session, prove that both
 * its client reference and customer belong to the active workspace, then run
 * the same idempotent subscription sync as the webhook. A forged/replayed
 * session id therefore cannot upgrade another workspace.
 */
export async function reconcileCompletedCheckout(
  input: ReconcileCheckoutInput,
  deps: ReconcileCheckoutDeps = {},
): Promise<void> {
  const pg = deps.pg ?? db();
  const stripe = deps.stripe
    ?? (stripeClient() as Pick<Stripe, "checkout" | "subscriptions">);

  const workspace = await pg.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM workspaces WHERE id = $1 LIMIT 1`,
    [input.workspaceId],
  );
  const expectedCustomerId = workspace.rows[0]?.stripe_customer_id;
  if (!expectedCustomerId) {
    throw new Error("checkout_workspace_has_no_stripe_customer");
  }

  const checkout = await stripe.checkout.sessions.retrieve(
    input.checkoutSessionId,
    { expand: ["subscription"] },
  );
  if (checkout.status !== "complete") {
    throw new Error(`checkout_not_complete:${checkout.status ?? "unknown"}`);
  }
  if (checkout.client_reference_id !== input.workspaceId) {
    throw new Error("checkout_workspace_mismatch");
  }

  const checkoutCustomerId = stripeObjectId(checkout.customer);
  if (checkoutCustomerId !== expectedCustomerId) {
    throw new Error("checkout_customer_mismatch");
  }

  let subscription: Stripe.Subscription;
  if (typeof checkout.subscription === "string") {
    subscription = await stripe.subscriptions.retrieve(checkout.subscription);
  } else if (checkout.subscription) {
    subscription = checkout.subscription;
  } else {
    throw new Error("checkout_subscription_missing");
  }

  if (stripeObjectId(subscription.customer) !== expectedCustomerId) {
    throw new Error("checkout_subscription_customer_mismatch");
  }
  await applyStripeSubscription(pg, subscription);
}

function stripeObjectId(value: string | { id: string } | null): string | null {
  if (typeof value === "string") return value;
  return value?.id ?? null;
}

async function ensureCustomerId(args: {
  workspaceId: string;
  userEmail: string;
  stripe: Pick<Stripe, "customers">;
  pg: Queryable;
}): Promise<string> {
  // Lazy single-row lookup. A workspace gets at most one Stripe
  // Customer object — if upgrade-cancel-re-upgrade happens, we
  // reuse the same id so invoice history follows the user.
  const existing = await args.pg.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM workspaces WHERE id = $1 LIMIT 1`,
    [args.workspaceId],
  );
  const id = existing.rows[0]?.stripe_customer_id;
  if (id) return id;

  const customer = await args.stripe.customers.create({
    email: args.userEmail,
    metadata: { workspace_id: args.workspaceId },
  });

  // Persist immediately so a concurrent upgrade or a Stripe webhook landing
  // before the user returns from Checkout can find the mapping. RETURNING the
  // row lets us detect the race: if two checkouts run concurrently both create
  // a customer, but only the first UPDATE matches `IS NULL`. The loser must
  // return the PERSISTED id (not its own orphan) — otherwise its Checkout
  // session attaches to a customer the webhook can't resolve, and the
  // workspace stays on Free despite a successful payment (audit high).
  const persisted = await args.pg.query<{ stripe_customer_id: string | null }>(
    `UPDATE workspaces SET stripe_customer_id = $2
      WHERE id = $1 AND stripe_customer_id IS NULL
      RETURNING stripe_customer_id`,
    [args.workspaceId, customer.id],
  );
  if (persisted.rows[0]?.stripe_customer_id) return persisted.rows[0].stripe_customer_id;

  // We lost the race (or it was already set). Read the winner's id and discard
  // our just-created orphan so it doesn't linger in Stripe (best-effort).
  const winner = await args.pg.query<{ stripe_customer_id: string | null }>(
    `SELECT stripe_customer_id FROM workspaces WHERE id = $1 LIMIT 1`,
    [args.workspaceId],
  );
  const winnerId = winner.rows[0]?.stripe_customer_id;
  if (winnerId && winnerId !== customer.id) {
    try {
      await args.stripe.customers.del(customer.id);
    } catch {
      // Orphan cleanup is best-effort — a stray customer with no subscription
      // is harmless and can be reaped later.
    }
    return winnerId;
  }
  return customer.id;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`${name} is required for the Stripe upgrade flow`);
  }
  return v;
}
