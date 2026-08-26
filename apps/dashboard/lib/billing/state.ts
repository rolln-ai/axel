import "server-only";
import type { Queryable } from "../db";
import { db } from "../db";

/**
 * Workspace-facing billing state — drives the /settings?tab=billing
 * panel and the upgrade/downgrade lifecycle CTAs. Single Postgres
 * round-trip per page render. ClickHouse is intentionally NOT touched
 * here; current-period totals come from `workspace_usage_period`
 * which the hourly rollup keeps fresh (see lib/billing/rollup.ts).
 */

export const FREE_TIER_TASK_CAP = 10_000;
export const PRO_INCLUDED_TASKS = 1_333_333; // approximately $20 / ($0.015 / 1000)
/** $0.015 per 1,000 inbound events, expressed as cents per 10k for integer math. */
export const PRO_CENTS_PER_10K = 15;

export type PlanId = "free" | "pro" | "enterprise";
export type BillingStatus = "ok" | "past_due" | "grace" | "suspended" | "canceled";

export interface WorkspaceBillingState {
  plan: PlanId;
  billingStatus: BillingStatus;
  /**
   * Super-admin comp (migration 0057): the ingest gate always accepts —
   * no payment method required, no free-tier cap, never auto-suspended
   * (plan-state.ts deriveGate). User-facing surfaces must not show
   * quota/suspension/upgrade notices for exempt workspaces.
   */
  billingExempt: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  billingPeriodStart: Date | null;
  billingPeriodEnd: Date | null;
  /** Calendar-month period start (matches workspace_usage_period.period_start). */
  currentPeriodStart: string;
  /** Tasks already counted toward the current period. */
  tasksThisPeriod: number;
  /** Last time the rollup forwarded usage to Stripe (Pro only). */
  reportedToStripeAt: Date | null;
  /** Most recent invoices, newest first. */
  recentInvoices: BillingInvoiceRow[];
}

export interface BillingInvoiceRow {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  periodStart: Date | null;
  periodEnd: Date | null;
  hostedUrl: string | null;
  pdfUrl: string | null;
  createdAt: Date;
}

interface UsageRow {
  plan: PlanId;
  billing_status: BillingStatus;
  billing_exempt: boolean;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  billing_period_start: Date | null;
  billing_period_end: Date | null;
  ingest_tasks: string | null;
  delivery_tasks: string | null;
  reported_to_stripe_at: Date | null;
}

export async function loadWorkspaceBillingState(
  workspaceId: string,
  pg: Queryable = db(),
): Promise<WorkspaceBillingState> {
  const periodStart = currentPeriodStartUtc();

  const [usage, invoices] = await Promise.all([
    pg.query<UsageRow>(
      `SELECT w.plan,
              w.billing_status,
              COALESCE(w.billing_exempt, false) AS billing_exempt,
              w.stripe_customer_id,
              w.stripe_subscription_id,
              w.billing_period_start,
              w.billing_period_end,
              up.ingest_tasks::text  AS ingest_tasks,
              up.delivery_tasks::text AS delivery_tasks,
              up.reported_to_stripe_at
         FROM workspaces w
         LEFT JOIN workspace_usage_period up
           ON up.workspace_id = w.id AND up.period_start = $2::date
        WHERE w.id = $1
        LIMIT 1`,
      [workspaceId, periodStart],
    ),
    pg.query<{
      id: string;
      status: string;
      total_cents: number;
      currency: string;
      period_start: Date | null;
      period_end: Date | null;
      hosted_url: string | null;
      pdf_url: string | null;
      created_at: Date;
    }>(
      `SELECT id, status, total_cents, currency,
              period_start, period_end, hosted_url, pdf_url, created_at
         FROM billing_invoices
        WHERE workspace_id = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [workspaceId],
    ),
  ]);

  const row = usage.rows[0];
  if (!row) {
    throw new Error(`workspace ${workspaceId} not found`);
  }

  const ingest = parseCount(row.ingest_tasks);
  return {
    plan: row.plan,
    billingStatus: row.billing_status,
    // Fail-safe like plan-state.ts: anything but an explicit true means
    // NOT exempt (billed + gated normally).
    billingExempt: row.billing_exempt === true,
    stripeCustomerId: row.stripe_customer_id,
    stripeSubscriptionId: row.stripe_subscription_id,
    billingPeriodStart: row.billing_period_start,
    billingPeriodEnd: row.billing_period_end,
    currentPeriodStart: periodStart,
    tasksThisPeriod: ingest,
    reportedToStripeAt: row.reported_to_stripe_at,
    recentInvoices: invoices.rows.map((inv) => ({
      id: inv.id,
      status: inv.status,
      totalCents: inv.total_cents,
      currency: inv.currency,
      periodStart: inv.period_start,
      periodEnd: inv.period_end,
      hostedUrl: inv.hosted_url,
      pdfUrl: inv.pdf_url,
      createdAt: inv.created_at,
    })),
  };
}

/**
 * Estimate the cost of the current-period usage in USD cents. Used
 * by /settings?tab=billing and /admin/billing tiles for a "next
 * invoice" projection. Mirrors the Stripe price config:
 *   free → $0 (any overage is hard-blocked)
 *   pro  → $20 base, applied as credit toward inbound usage billed at
 *          $0.015 / 1,000 accepted inbound events.
 */
export function estimateInvoiceCents(state: WorkspaceBillingState): number {
  return estimateInvoiceCentsFor(state.plan, state.tasksThisPeriod);
}

/**
 * Same projection as `estimateInvoiceCents` but from primitives, so callers that
 * only have (plan, tasks) — e.g. the hourly billing dispatcher — don't have to
 * build a full WorkspaceBillingState.
 */
export function estimateInvoiceCentsFor(plan: PlanId, tasksThisPeriod: number): number {
  if (plan === "free") return 0;
  const baseCents = 2000;
  const usageCents = Math.ceil((tasksThisPeriod * PRO_CENTS_PER_10K) / 10_000);
  return Math.max(baseCents, usageCents);
}

function currentPeriodStartUtc(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return d.toISOString().slice(0, 10);
}

function parseCount(input: string | null): number {
  if (input == null) return 0;
  const n = Number(input);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
