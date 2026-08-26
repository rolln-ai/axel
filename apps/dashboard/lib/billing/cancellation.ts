import "server-only";
import type Stripe from "stripe";
import { stripeClient } from "./stripe-client";

/**
 * Cancel a workspace's subscription during teardown, billing any usage the
 * customer accrued before deletion.
 *
 * `invoice_now: true` tells Stripe to immediately generate a final invoice for
 * un-invoiced metered usage (the tasks the workspace sent this period, reported
 * to the meter just before this call). `prorate: false` because metered usage
 * is billed on actual reported quantity, not time-prorated — the customer pays
 * for exactly the events they pushed through.
 *
 * Idempotent for the teardown sweep: if the subscription is already gone (a
 * retry after we canceled, or the customer.subscription.deleted webhook raced
 * us), that's treated as success rather than an error.
 */
export async function cancelSubscriptionWithFinalInvoice(
  subscriptionId: string,
  deps: { stripe?: Pick<Stripe, "subscriptions"> } = {},
): Promise<{ canceled: boolean; alreadyGone: boolean }> {
  const stripe = deps.stripe ?? (stripeClient() as Pick<Stripe, "subscriptions">);
  try {
    await stripe.subscriptions.cancel(subscriptionId, {
      invoice_now: true,
      prorate: false,
    });
    return { canceled: true, alreadyGone: false };
  } catch (err) {
    if (isAlreadyGone(err)) return { canceled: false, alreadyGone: true };
    throw err;
  }
}

function isAlreadyGone(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; statusCode?: number; message?: string };
  if (e.code === "resource_missing") return true;
  if (e.statusCode === 404) return true;
  const msg = (e.message ?? "").toLowerCase();
  return (
    msg.includes("no such subscription") ||
    msg.includes("already canceled") ||
    msg.includes("cannot be updated") // canceled subs reject further mutations
  );
}
