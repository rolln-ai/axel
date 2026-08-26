import { FREE_TIER_TASK_CAP, type WorkspaceBillingState } from "./state";

export const FREE_WARNING_THRESHOLD = 8_000;

export interface BillingBannerNotice {
  tone: "warning" | "destructive";
  title: string;
  body: string;
  cta: string;
}

export type BillingBannerState = Pick<
  WorkspaceBillingState,
  "plan" | "billingStatus" | "billingExempt" | "tasksThisPeriod"
>;

/**
 * Decide which (if any) workspace-wide billing notice to show above
 * (app) page content. Pure so the branch matrix is unit-testable;
 * BillingBanner.tsx renders the result. Priority order and gate
 * semantics mirror plan-state.ts deriveGate:
 *
 *   1. billing_status='suspended'/'canceled' — ingest is 402-blocked.
 *   2. billing_status='past_due'/'grace' — dunning/abnormal, still flowing.
 *   3. plan='free' + cap reached — ingest is 429-blocked. Prompts upgrade.
 *   4. plan='free' + approaching cap — warning before block.
 *
 * billing_exempt short-circuits everything: the gate always accepts for
 * comped workspaces (deriveGate returns "accept" before it even looks at
 * billing_status or the cap), so every notice below would claim a block
 * that never happens. Same exclusion the email dispatcher applies.
 */
export function deriveBillingBannerNotice(state: BillingBannerState): BillingBannerNotice | null {
  if (state.billingExempt) return null;

  if (state.billingStatus === "suspended") {
    return {
      tone: "destructive",
      title: "Billing suspended — ingest is paused",
      body: "The ingest worker is returning 402 to incoming webhooks for this workspace. Update your payment method to restore service.",
      cta: "Manage billing",
    };
  }
  if (state.billingStatus === "canceled") {
    // canceled maps to reject_suspended in the gate — ingest is 402-blocked,
    // exactly like 'suspended' — so it MUST surface a banner (it previously fell
    // through to null, leaving a blank above-the-fold while ingest was blocked).
    return {
      tone: "destructive",
      title: "Subscription canceled — ingest is paused",
      body: "Your Pro subscription was canceled, so the ingest worker is returning 402 to incoming webhooks. Re-subscribe to restore service.",
      cta: "Manage billing",
    };
  }
  if (state.billingStatus === "past_due") {
    return {
      tone: "destructive",
      title: "Last payment failed",
      body: "Stripe will keep retrying; ingest is still flowing. Update your card to avoid suspension.",
      cta: "Manage billing",
    };
  }
  if (state.billingStatus === "grace") {
    // grace (Stripe 'incomplete'/'paused') still accepts ingest, but the
    // subscription is in an abnormal state — surface it so the operator knows
    // whether action is needed rather than showing an unexplained 'grace' badge.
    return {
      tone: "warning",
      title: "Payment is processing",
      body: "Your subscription is confirming (or paused). Ingest is still flowing; if this persists, check your payment method.",
      cta: "Manage billing",
    };
  }
  if (state.plan === "free" && state.tasksThisPeriod >= FREE_TIER_TASK_CAP) {
    return {
      tone: "destructive",
      title: `Free-tier cap reached (${FREE_TIER_TASK_CAP.toLocaleString()} tasks)`,
      body: "Ingest is returning 429 to new webhooks until next month or until you upgrade to Pro.",
      cta: "Upgrade to Pro",
    };
  }
  if (state.plan === "free" && state.tasksThisPeriod >= FREE_WARNING_THRESHOLD) {
    return {
      tone: "warning",
      title: `Approaching free-tier cap (${state.tasksThisPeriod.toLocaleString()} of ${FREE_TIER_TASK_CAP.toLocaleString()})`,
      body: "Ingest will start returning 429 once the cap is hit. Upgrade to Pro to remove the limit.",
      cta: "Upgrade to Pro",
    };
  }
  return null;
}
