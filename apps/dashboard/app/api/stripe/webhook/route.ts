import { processStripeWebhook } from "../../../../lib/billing/webhook-handler";
import { hasStripeConfigured, stripeClient, stripeWebhookSecret } from "../../../../lib/billing/stripe-client";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Stripe webhook entrypoint. Verifies the signature using
 * `STRIPE_WEBHOOK_SECRET` so this endpoint cannot be spoofed by
 * anyone who guesses the path. Delegates the actual state changes to
 * `processStripeWebhook`, which is idempotent via the `billing_events`
 * PK.
 *
 * Returns 200 only when the event is either applied or recognized as
 * a known duplicate; any other failure is 500 so Stripe retries.
 */
export async function POST(request: Request): Promise<Response> {
  if (!hasStripeConfigured()) {
    return Response.json({ ok: false, error: "stripe_not_configured" }, { status: 503 });
  }
  const sig = request.headers.get("stripe-signature");
  if (!sig) {
    return Response.json({ ok: false, error: "missing_signature" }, { status: 400 });
  }

  const body = await request.text();
  let event: ReturnType<ReturnType<typeof stripeClient>["webhooks"]["constructEvent"]>;
  try {
    event = stripeClient().webhooks.constructEvent(body, sig, stripeWebhookSecret());
  } catch {
    // Signature failure or malformed payload — never journal these
    // (they're often probes). Return 400 so Stripe stops retrying.
    return Response.json(
      { ok: false, error: "invalid_signature" },
      { status: 400 },
    );
  }

  try {
    const result = await processStripeWebhook(event);
    return Response.json({ ok: true, ...result });
  } catch {
    await captureDashboardException(new Error("stripe_webhook_processing_failed"), {
      tags: { component: "stripe_webhook", event_id: event.id, event_type: event.type },
    });
    return Response.json(
      { ok: false, error: "stripe_webhook_processing_failed" },
      { status: 500 },
    );
  }
}
