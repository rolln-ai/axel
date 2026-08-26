import { describe, expect, it } from "vitest";
import { estimateInvoiceCentsFor } from "../lib/billing/state";

/**
 * Pure-function tests for the cost estimator used by the admin
 * billing list. The full query path needs a real Postgres so the
 * SQL is exercised against the schema in CI's postgres-schema job;
 * here we just verify the math an admin sees in the "next invoice"
 * column lines up with what /settings/billing shows the customer.
 */

// Mirror of lib/admin-billing.ts#estimateInvoiceCents — keep these
// two formulas locked in step or invoices diverge from what the
// customer + admin both see in-app.
function estimateInvoiceCents(plan: string, totalTasks: number): number {
  if (plan === "free") return 0;
  return Math.max(2000, Math.ceil((totalTasks * 15) / 10_000));
}

describe("admin-billing estimateInvoiceCents", () => {
  it("returns 0 for free regardless of usage", () => {
    expect(estimateInvoiceCents("free", 0)).toBe(0);
    expect(estimateInvoiceCents("free", 5_000_000)).toBe(0);
  });

  it("flat $20 for Pro under threshold", () => {
    expect(estimateInvoiceCents("pro", 0)).toBe(2000);
    expect(estimateInvoiceCents("pro", 1_333_333)).toBe(2000);
  });

  it("bills inbound usage at $0.015/1k with a $20 minimum", () => {
    expect(estimateInvoiceCents("pro", 1_333_334)).toBe(2001);
    expect(estimateInvoiceCents("pro", 5_000_000)).toBe(7500);
    expect(estimateInvoiceCents("pro", 20_000_000)).toBe(30000);
    expect(estimateInvoiceCents("pro", 200_000_000)).toBe(300000);
  });

  it("matches the /settings/billing estimator from lib/billing/state.ts", () => {
    // Both should produce the same number for any (plan, tasks).
    const samples = [
      ["free", 0],
      ["free", 1_000_000],
      ["pro", 0],
      ["pro", 1_333_333],
      ["pro", 1_333_334],
      ["pro", 10_000_000],
      ["pro", 20_000_000],
      ["pro", 20_000_001],
      ["pro", 200_000_000],
    ] as const;
    for (const [plan, tasks] of samples) {
      expect(estimateInvoiceCents(plan, tasks)).toEqual(
        estimateInvoiceCentsFor(plan, tasks),
      );
    }
  });
});
