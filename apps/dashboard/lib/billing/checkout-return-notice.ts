export interface CheckoutReturnNotice {
  tone: "success" | "info";
  title: string;
  body: string;
}

/**
 * Decide which (if any) notice to show when the user lands back on
 * Settings → Billing from Stripe Checkout. createCheckoutSession round-trips
 * `checkout=success` / `checkout=cancel` on its successUrl/cancelUrl, and the
 * settings route preserves `checkout=success` through its reconcile redirect —
 * previously both params were consumed with no user-visible confirmation, so
 * the only signal of a completed upgrade was the Plan badge silently flipping.
 *
 * Pure so the param matrix is unit-testable; CheckoutReturnNotice.tsx renders
 * the result as a dismissible banner above the Billing panel.
 */
export function deriveCheckoutReturnNotice(
  checkoutParam: string | undefined,
): CheckoutReturnNotice | null {
  if (checkoutParam === "success") {
    return {
      tone: "success",
      title: "Payment successful — welcome to Pro",
      body: "Your subscription is active. Usage above the included allowance now bills at Pro rates, and the free-tier ingest cap no longer applies.",
    };
  }
  if (checkoutParam === "cancel") {
    return {
      tone: "info",
      title: "Checkout canceled",
      body: "No changes were made — you're still on your current plan. You can upgrade any time.",
    };
  }
  // Anything else (absent, or an unexpected value) shows nothing.
  return null;
}
