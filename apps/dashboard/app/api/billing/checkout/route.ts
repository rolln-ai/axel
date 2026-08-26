import { appBaseUrl } from "../../../../lib/app-url";
import { createCheckoutSession } from "../../../../lib/billing/checkout";
import { hasStripeConfigured } from "../../../../lib/billing/stripe-client";
import { captureDashboardException } from "../../../../lib/sentry-capture";
import { requireSession } from "../../../../lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * Starts the Pro upgrade flow. Owner-only — workspace admins and
 * members get 403. Returns the Stripe Checkout URL the client should
 * window.location to.
 */
export async function POST(_request: Request): Promise<Response> {
  if (!hasStripeConfigured()) {
    return Response.json({ ok: false, error: "stripe_not_configured" }, { status: 503 });
  }
  const session = await requireSession();
  if (session.activeWorkspace.role !== "owner") {
    return Response.json({ ok: false, error: "owner_required" }, { status: 403 });
  }

  try {
    const baseUrl = appBaseUrl();
    const result = await createCheckoutSession({
      workspaceId: session.activeWorkspace.workspace_id,
      userEmail: session.user.email,
      // Stripe replaces this literal placeholder after Checkout completes.
      // Passing the session id back lets the settings page synchronously
      // reconcile the paid subscription instead of briefly rendering the
      // stale Free plan while the webhook is still in flight.
      successUrl: `${baseUrl}/settings?tab=billing&checkout=success&checkout_session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${baseUrl}/settings?tab=billing&checkout=cancel`,
    });
    return Response.json({ ok: true, url: result.url });
  } catch (err) {
    await captureDashboardException(err, {
      tags: {
        component: "billing_checkout",
        workspace_id: session.activeWorkspace.workspace_id,
      },
    });
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
