"use client";

import { Button } from "@/components/ui/button";
import type { PlanId } from "../../../lib/billing/state";
import { useAction } from "../../_components/useAction";
import { useActionStateToast } from "../../_components/Toast";

interface BillingActionButtonsProps {
  plan: PlanId;
  isOwner: boolean;
  /** Comped workspace — billing is admin-managed, no self-serve actions. */
  billingExempt: boolean;
  /** Without a Stripe customer there is no portal session to open. */
  hasStripeCustomer: boolean;
}

/**
 * Two-button client island over the Billing panel. Calls the
 * /api/billing/{checkout,portal} endpoints (which gate by owner role
 * server-side too — the disabled state here is just UX) and
 * window.location's to the returned Stripe URL.
 */
export function BillingActionButtons({
  plan,
  isOwner,
  billingExempt,
  hasStripeCustomer,
}: BillingActionButtonsProps) {
  const billing = useAction(async (endpoint: "checkout" | "portal") => {
    try {
      const res = await fetch(`/api/billing/${endpoint}`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) {
        throw new Error(body.error ?? `Request failed with ${res.status}`);
      }
      window.location.href = body.url;
      return {};
    } catch (err) {
      return { error: err instanceof Error ? err.message : "Billing request failed" };
    }
  });
  useActionStateToast({ error: billing.error });
  const { pending } = billing;

  if (!isOwner) {
    return (
      <p className="text-xs text-muted-foreground">
        Only the workspace owner can change billing.
      </p>
    );
  }

  // Comped workspaces and admin-set Pro/Enterprise plans have no Stripe
  // customer, so there is no Checkout to run or portal to open — pointing
  // the owner at either would just error ("upgrade first" while their badge
  // already reads Pro). Say who owns billing instead.
  if (billingExempt || (plan !== "free" && !hasStripeCustomer)) {
    return (
      <p className="text-xs text-muted-foreground">
        Billing for this workspace is managed by Axel — contact support to make changes.
      </p>
    );
  }

  if (plan === "free") {
    return (
      <Button
        onClick={() => billing.run("checkout")}
        disabled={pending}
        size="sm"
      >
        {pending ? "Opening Stripe…" : "Upgrade to Pro"}
      </Button>
    );
  }

  return (
    <Button
      onClick={() => billing.run("portal")}
      disabled={pending}
      size="sm"
      variant="outline"
    >
      {pending ? "Opening portal…" : "Manage billing"}
    </Button>
  );
}
