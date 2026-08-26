import { appBaseUrl } from "../../../../lib/app-url";
import { createPortalSession, NoStripeCustomerError } from "../../../../lib/billing/checkout";
import { hasStripeConfigured } from "../../../../lib/billing/stripe-client";
import { captureDashboardException } from "../../../../lib/sentry-capture";
import { requireSession } from "../../../../lib/session";

export const runtime = "nodejs";
export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * Stripe Customer Portal session — card updates, invoices,
 * cancellation. Owner-only; the portal is Stripe-hosted so we don't
 * need to build a custom UI for those flows.
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
    const result = await createPortalSession({
      workspaceId: session.activeWorkspace.workspace_id,
      returnUrl: `${baseUrl}/settings?tab=billing`,
    });
    return Response.json({ ok: true, url: result.url });
  } catch (err) {
    if (err instanceof NoStripeCustomerError) {
      // Expected for comped/admin-set plans — the UI hides the portal button
      // for them, so don't page Sentry or echo the internal message.
      return Response.json(
        {
          ok: false,
          error: "Billing for this workspace is managed by Axel — contact support to make changes.",
        },
        { status: 409 },
      );
    }
    await captureDashboardException(err, {
      tags: {
        component: "billing_portal",
        workspace_id: session.activeWorkspace.workspace_id,
      },
    });
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
