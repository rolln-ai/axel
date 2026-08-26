import { describe, expect, it } from "vitest";
import { decideEmailKinds, decideUsageInvoiceKinds } from "../lib/billing/email-dispatcher";

describe("decideEmailKinds", () => {
  it("returns nothing for healthy Pro workspaces", () => {
    expect(decideEmailKinds("pro", "ok", 5_000_000)).toEqual([]);
  });

  it("returns nothing for free workspaces under 8k", () => {
    expect(decideEmailKinds("free", "ok", 7_999)).toEqual([]);
  });

  it("sends quota_warning at 8k tasks on free", () => {
    expect(decideEmailKinds("free", "ok", 8_000)).toEqual(["quota_warning"]);
    expect(decideEmailKinds("free", "ok", 9_500)).toEqual(["quota_warning"]);
  });

  it("upgrades to quota_blocked once free hits 10k", () => {
    expect(decideEmailKinds("free", "ok", 10_000)).toEqual(["quota_blocked"]);
    expect(decideEmailKinds("free", "ok", 50_000)).toEqual(["quota_blocked"]);
  });

  it("sends payment_failed for past_due regardless of plan or usage", () => {
    expect(decideEmailKinds("pro", "past_due", 0)).toEqual(["payment_failed"]);
    expect(decideEmailKinds("pro", "past_due", 1_000_000)).toEqual(["payment_failed"]);
  });

  it("sends billing_suspended for suspended (replaces past_due)", () => {
    expect(decideEmailKinds("pro", "suspended", 0)).toEqual(["billing_suspended"]);
  });

  it("combines suspension AND free quota when both apply", () => {
    // A free workspace that was suspended for some reason AND is also
    // at the cap should hear about both situations.
    expect(decideEmailKinds("free", "suspended", 12_000)).toEqual([
      "billing_suspended",
      "quota_blocked",
    ]);
  });

  it("treats grace as ok (Stripe is mid-dunning; no email yet)", () => {
    expect(decideEmailKinds("pro", "grace", 1_000)).toEqual([]);
  });

  it("does not emit free-tier quota alerts for billing-exempt workspaces", () => {
    expect(decideEmailKinds("free", "ok", 50_000, true)).toEqual([]);
  });
});

describe("decideUsageInvoiceKinds", () => {
  // 2026-06-15 — day 15 of a 30-day month, so projection = tasks * 2.
  const now = new Date("2026-06-15T12:00:00.000Z");

  it("ignores non-Pro plans entirely", () => {
    expect(
      decideUsageInvoiceKinds({
        plan: "free",
        tasksThisPeriod: 1_000_000,
        priorPeriodTasks: 1_000,
        billingPeriodEnd: new Date("2026-06-16T12:00:00.000Z"),
        now,
      }),
    ).toEqual([]);
  });

  it("flags an upcoming invoice within 3 days of period end", () => {
    expect(
      decideUsageInvoiceKinds({
        plan: "pro",
        tasksThisPeriod: 0,
        priorPeriodTasks: null,
        billingPeriodEnd: new Date("2026-06-17T12:00:00.000Z"),
        now,
      }),
    ).toEqual(["upcoming_invoice"]);
  });

  it("does not flag an upcoming invoice that's still far off", () => {
    expect(
      decideUsageInvoiceKinds({
        plan: "pro",
        tasksThisPeriod: 0,
        priorPeriodTasks: null,
        billingPeriodEnd: new Date("2026-06-30T12:00:00.000Z"),
        now,
      }),
    ).toEqual([]);
  });

  it("flags a usage spike when projected usage is ≥2× the prior period", () => {
    expect(
      decideUsageInvoiceKinds({
        plan: "pro",
        tasksThisPeriod: 12_000, // projects to 24,000 ≥ 2×10,000
        priorPeriodTasks: 10_000,
        billingPeriodEnd: null,
        now,
      }),
    ).toEqual(["usage_spike"]);
  });

  it("does not spike-alert when the projection is under 2×", () => {
    expect(
      decideUsageInvoiceKinds({
        plan: "pro",
        tasksThisPeriod: 9_000, // projects to 18,000 < 20,000
        priorPeriodTasks: 10_000,
        billingPeriodEnd: null,
        now,
      }),
    ).toEqual([]);
  });

  it("suppresses spikes early in the month and for tiny baselines", () => {
    const earlyDay = new Date("2026-06-03T12:00:00.000Z");
    expect(
      decideUsageInvoiceKinds({
        plan: "pro",
        tasksThisPeriod: 50_000,
        priorPeriodTasks: 10_000,
        billingPeriodEnd: null,
        now: earlyDay,
      }),
    ).toEqual([]);
    expect(
      decideUsageInvoiceKinds({
        plan: "pro",
        tasksThisPeriod: 5_000,
        priorPeriodTasks: 500, // below MIN_PRIOR_TASKS_FOR_SPIKE
        billingPeriodEnd: null,
        now,
      }),
    ).toEqual([]);
  });
});
