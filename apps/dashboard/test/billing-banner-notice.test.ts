import { describe, expect, it } from "vitest";
import {
  deriveBillingBannerNotice,
  FREE_WARNING_THRESHOLD,
  type BillingBannerState,
} from "../lib/billing/banner-notice";
import { FREE_TIER_TASK_CAP } from "../lib/billing/state";

function makeState(overrides: Partial<BillingBannerState> = {}): BillingBannerState {
  return {
    plan: "free",
    billingStatus: "ok",
    billingExempt: false,
    tasksThisPeriod: 0,
    ...overrides,
  };
}

describe("deriveBillingBannerNotice", () => {
  it("returns null for a healthy workspace", () => {
    expect(deriveBillingBannerNotice(makeState())).toBeNull();
    expect(deriveBillingBannerNotice(makeState({ plan: "pro" }))).toBeNull();
  });

  it("shows a destructive suspension notice when billing_status is suspended", () => {
    const notice = deriveBillingBannerNotice(makeState({ billingStatus: "suspended" }));
    expect(notice).toMatchObject({ tone: "destructive", cta: "Manage billing" });
    expect(notice?.title).toMatch(/suspended/i);
  });

  it("shows a destructive notice for canceled (also 402-gated)", () => {
    const notice = deriveBillingBannerNotice(
      makeState({ plan: "pro", billingStatus: "canceled" }),
    );
    expect(notice).toMatchObject({ tone: "destructive" });
    expect(notice?.title).toMatch(/canceled/i);
  });

  it("shows dunning notices for past_due and grace", () => {
    expect(
      deriveBillingBannerNotice(makeState({ plan: "pro", billingStatus: "past_due" })),
    ).toMatchObject({ tone: "destructive", title: "Last payment failed" });
    expect(
      deriveBillingBannerNotice(makeState({ plan: "pro", billingStatus: "grace" })),
    ).toMatchObject({ tone: "warning", title: "Payment is processing" });
  });

  it("shows cap-reached / approaching-cap notices for free workspaces", () => {
    expect(
      deriveBillingBannerNotice(makeState({ tasksThisPeriod: FREE_TIER_TASK_CAP })),
    ).toMatchObject({ tone: "destructive", cta: "Upgrade to Pro" });
    expect(
      deriveBillingBannerNotice(makeState({ tasksThisPeriod: FREE_WARNING_THRESHOLD })),
    ).toMatchObject({ tone: "warning", cta: "Upgrade to Pro" });
  });

  it("does not show cap notices to non-free plans", () => {
    expect(
      deriveBillingBannerNotice(makeState({ plan: "pro", tasksThisPeriod: 5_000_000 })),
    ).toBeNull();
    expect(
      deriveBillingBannerNotice(makeState({ plan: "enterprise", tasksThisPeriod: 5_000_000 })),
    ).toBeNull();
  });

  it("suppresses every notice for billing-exempt workspaces (gate always accepts)", () => {
    // The gate never blocks exempt workspaces (plan-state.ts deriveGate), so
    // even stale suspended/past_due statuses and over-cap usage must not
    // surface an "ingest is blocked" banner.
    const exempt = { billingExempt: true } as const;
    expect(
      deriveBillingBannerNotice(makeState({ ...exempt, billingStatus: "suspended" })),
    ).toBeNull();
    expect(
      deriveBillingBannerNotice(makeState({ ...exempt, billingStatus: "canceled" })),
    ).toBeNull();
    expect(
      deriveBillingBannerNotice(makeState({ ...exempt, billingStatus: "past_due" })),
    ).toBeNull();
    expect(
      deriveBillingBannerNotice(
        makeState({ ...exempt, tasksThisPeriod: FREE_TIER_TASK_CAP * 5 }),
      ),
    ).toBeNull();
  });
});
