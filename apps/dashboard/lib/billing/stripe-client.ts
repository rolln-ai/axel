import "server-only";
import Stripe from "stripe";

/**
 * Singleton Stripe client. The SDK is heavy enough that we keep one
 * instance per process; lazy-initialised so that every other module
 * importing from `lib/billing/*` doesn't crash at boot when Stripe
 * isn't configured (free-only deployments, local dev).
 *
 * `apiVersion` is pinned so a future Stripe API change can't silently
 * alter webhook payload shapes during a deploy. Bump the constant
 * deliberately when we vet a new version.
 */

const STRIPE_API_VERSION = "2026-05-27.dahlia" as const;

declare global {
  // eslint-disable-next-line no-var
  var __axelStripeClient: Stripe | undefined;
}

export function hasStripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "STRIPE_SECRET_KEY is required for billing operations (Stripe Checkout, webhooks, meter forwarding).",
    );
  }
  if (!globalThis.__axelStripeClient) {
    globalThis.__axelStripeClient = new Stripe(key, {
      apiVersion: STRIPE_API_VERSION,
      typescript: true,
      maxNetworkRetries: 2,
    });
  }
  return globalThis.__axelStripeClient;
}

/** Reads the Stripe webhook signing secret with a clear error if absent. */
export function stripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is required to verify webhook signatures");
  }
  return secret;
}
