import "server-only";
import type { Queryable } from "../db";
import { db } from "../db";
import { emitNotification, type CreateNotificationInput } from "../notifications";
import { estimateInvoiceCentsFor } from "./state";
import { sendBillingEmail, type BillingEmailKind } from "./emails";
import { hasStripeConfigured } from "./stripe-client";

/**
 * After the hourly rollup, look at every active workspace and decide whether it
 * has crossed an email-worthy threshold this period. Each sendBillingEmail call
 * is idempotent via the billing_events PK, so this can run every hour without
 * spamming — only the first cross of each threshold per period produces an email.
 *
 * Two responsibilities beyond email:
 *   - Usage/invoice signals (Pro): an "upcoming invoice" heads-up a few days
 *     before period end, and a "usage running higher than last month" spike
 *     alert — so a bigger bill is never a surprise.
 *   - In-app dual-write: every billing notice is also written to the
 *     notifications table (workspace-wide) so it shows in the bell and the
 *     daily digest, not just email. Emitted exactly once per period, gated on
 *     the email idempotency journal (`deduped`).
 */

const FREE_TIER_TASK_CAP = 10_000;
const FREE_WARNING_THRESHOLD = 8_000;
const MIN_PRIOR_TASKS_FOR_SPIKE = 1_000;
const SPIKE_MULTIPLIER = 2;
const UPCOMING_INVOICE_WINDOW_DAYS = 3;

export interface BillingEmailDispatchSummary {
  sent: number;
  alreadySent: number;
  failed: number;
  notificationsEmitted: number;
}

export async function dispatchBillingEmails(
  deps: { pg?: Queryable; now?: Date } = {},
): Promise<BillingEmailDispatchSummary> {
  // Stripe-less deployments enforce no caps (plan-state.ts deriveGate), so
  // cap-warning emails would tell users to upgrade to a plan that doesn't
  // exist. Skip the whole dispatch.
  if (!hasStripeConfigured()) {
    return { sent: 0, alreadySent: 0, failed: 0, notificationsEmitted: 0 };
  }
  const pg = deps.pg ?? db();
  const now = deps.now ?? new Date();
  const periodStart = currentPeriodStartUtc(now);
  const priorPeriodStart = previousPeriodStartUtc(now);

  // Fetch every active workspace's plan/status + this-period total + prior-month
  // total + period end in one query so we don't N+1 over billing-state reads.
  const { rows } = await pg.query<{
    workspace_id: string;
    workspace_name: string;
    plan: "free" | "pro" | "enterprise";
    billing_status: "ok" | "past_due" | "grace" | "suspended" | "canceled";
    billing_exempt: boolean;
    total_tasks: string;
    prior_total_tasks: string | null;
    billing_period_end: Date | null;
  }>(
    `SELECT w.id           AS workspace_id,
            w.name         AS workspace_name,
            w.plan,
            w.billing_status,
            COALESCE(w.billing_exempt, false) AS billing_exempt,
            w.billing_period_end,
            COALESCE(up.total_tasks, 0)::text AS total_tasks,
            prev.total_tasks::text            AS prior_total_tasks
       FROM workspaces w
       LEFT JOIN workspace_usage_period up
         ON up.workspace_id = w.id AND up.period_start = $1::date
       LEFT JOIN workspace_usage_period prev
         ON prev.workspace_id = w.id AND prev.period_start = $2::date
      WHERE w.status = 'active'`,
    [periodStart, priorPeriodStart],
  );

  const summary: BillingEmailDispatchSummary = {
    sent: 0,
    alreadySent: 0,
    failed: 0,
    notificationsEmitted: 0,
  };
  for (const row of rows) {
    const tasks = Number(row.total_tasks) || 0;
    const priorTasks = row.prior_total_tasks == null ? null : Number(row.prior_total_tasks);
    const kinds = [
      ...decideEmailKinds(row.plan, row.billing_status, tasks, row.billing_exempt),
      ...decideUsageInvoiceKinds({
        plan: row.plan,
        tasksThisPeriod: tasks,
        priorPeriodTasks: priorTasks,
        billingPeriodEnd: row.billing_period_end,
        now,
      }),
    ];
    const estimatedCents = estimateInvoiceCentsFor(row.plan, tasks);
    const periodEndLabel = row.billing_period_end
      ? formatPeriodEnd(row.billing_period_end)
      : undefined;

    for (const kind of kinds) {
      try {
        const result = await sendBillingEmail(
          {
            workspaceId: row.workspace_id,
            workspaceName: row.workspace_name,
            kind,
            tasksThisPeriod: tasks,
            estimatedCents,
            periodEndLabel,
          },
          { pg },
        );
        if (result.sent) summary.sent += 1;
        else summary.alreadySent += 1;
        // Dual-write the in-app notification exactly once per period — on the
        // first cross, when the email idempotency row was freshly inserted.
        if (!result.deduped) {
          const emitted = await emitNotification(
            billingNotificationFor(kind, {
              workspaceId: row.workspace_id,
              periodStart,
              periodEndLabel,
              estimatedCents,
              tasks,
            }),
            pg,
          );
          if (emitted) summary.notificationsEmitted += 1;
        }
      } catch {
        summary.failed += 1;
      }
    }
  }
  return summary;
}

export function decideEmailKinds(
  plan: "free" | "pro" | "enterprise",
  billingStatus: "ok" | "past_due" | "grace" | "suspended" | "canceled",
  tasksThisPeriod: number,
  billingExempt = false,
): BillingEmailKind[] {
  const kinds: BillingEmailKind[] = [];
  // Suspension and past-due are independent of plan: a Pro workspace
  // with a failed payment also needs to hear about it.
  if (billingStatus === "suspended") kinds.push("billing_suspended");
  else if (billingStatus === "past_due") kinds.push("payment_failed");

  if (plan === "free" && !billingExempt) {
    if (tasksThisPeriod >= FREE_TIER_TASK_CAP) {
      kinds.push("quota_blocked");
    } else if (tasksThisPeriod >= FREE_WARNING_THRESHOLD) {
      kinds.push("quota_warning");
    }
  }
  return kinds;
}

export interface UsageInvoiceSignals {
  plan: "free" | "pro" | "enterprise";
  tasksThisPeriod: number;
  /** Prior calendar month's total_tasks, or null when there's no prior row. */
  priorPeriodTasks: number | null;
  billingPeriodEnd: Date | null;
  now: Date;
}

/**
 * Pro-only usage/invoice signals. Free is gated by the hard cap
 * (quota_warning/quota_blocked) and enterprise is contract-billed, so neither
 * needs these. Kept as a separate pure function from `decideEmailKinds` so the
 * latter's stable 3-arg signature (and its tests) are untouched.
 */
export function decideUsageInvoiceKinds(s: UsageInvoiceSignals): BillingEmailKind[] {
  const kinds: BillingEmailKind[] = [];
  if (s.plan !== "pro") return kinds;

  if (s.billingPeriodEnd) {
    const daysLeft = (s.billingPeriodEnd.getTime() - s.now.getTime()) / 86_400_000;
    if (daysLeft > 0 && daysLeft <= UPCOMING_INVOICE_WINDOW_DAYS) {
      kinds.push("upcoming_invoice");
    }
  }

  // Anomaly: project this period's run-rate and compare to the prior period.
  // Guards prevent day-1 noise: need a meaningful prior baseline, at least the
  // 5th of the month so the extrapolation isn't dominated by a slow start, and
  // real volume already accrued (not a spike conjured purely from projection).
  if (s.priorPeriodTasks != null && s.priorPeriodTasks >= MIN_PRIOR_TASKS_FOR_SPIKE) {
    const dayOfMonth = s.now.getUTCDate();
    if (dayOfMonth >= 5) {
      const daysInMonth = daysInUtcMonth(s.now);
      const projected = (s.tasksThisPeriod * daysInMonth) / dayOfMonth;
      const accruedEnough = s.tasksThisPeriod >= s.priorPeriodTasks * 0.25;
      if (accruedEnough && projected >= SPIKE_MULTIPLIER * s.priorPeriodTasks) {
        kinds.push("usage_spike");
      }
    }
  }
  return kinds;
}

interface BillingNotificationCtx {
  workspaceId: string;
  periodStart: string;
  periodEndLabel: string | undefined;
  estimatedCents: number;
  tasks: number;
}

/** Map a billing email kind to its in-app notification (workspace-wide). */
function billingNotificationFor(
  kind: BillingEmailKind,
  ctx: BillingNotificationCtx,
): CreateNotificationInput {
  const base = {
    workspaceId: ctx.workspaceId,
    userId: null,
    linkPath: "/settings?tab=billing",
  } satisfies Partial<CreateNotificationInput>;
  const period = ctx.periodStart;
  switch (kind) {
    case "quota_warning":
      return {
        ...base,
        kind: "billing_quota_warning",
        severity: "warning",
        title: "Approaching your monthly task cap",
        bodyMd: `You've used ${ctx.tasks.toLocaleString()} of 10,000 free-tier tasks this month.`,
        dedupKey: `billing:quota_warning:${period}`,
      };
    case "quota_blocked":
      return {
        ...base,
        kind: "billing_quota_blocked",
        severity: "high",
        title: "Free-tier cap reached — ingest paused",
        bodyMd: `Ingest is returning 429 until next month or until you upgrade. ${ctx.tasks.toLocaleString()} tasks used.`,
        dedupKey: `billing:quota_blocked:${period}`,
      };
    case "payment_failed":
      return {
        ...base,
        kind: "billing_payment_failed",
        severity: "high",
        title: "Payment failed",
        bodyMd: "Stripe couldn't charge your card. Update your payment method to avoid suspension.",
        dedupKey: `billing:payment_failed:${period}`,
      };
    case "billing_suspended":
      return {
        ...base,
        kind: "billing_suspended",
        severity: "high",
        title: "Billing suspended — ingest paused",
        bodyMd: "Service is suspended for non-payment. Update your payment method to restore it.",
        dedupKey: `billing:suspended:${period}`,
      };
    case "upcoming_invoice":
      return {
        ...base,
        kind: "billing_upcoming_invoice",
        severity: "info",
        title: ctx.periodEndLabel ? `Upcoming invoice — period ends ${ctx.periodEndLabel}` : "Upcoming invoice",
        bodyMd: `Estimated invoice so far: ${dollars(ctx.estimatedCents)}. No action needed — just so it's never a surprise.`,
        dedupKey: `billing:upcoming_invoice:${ctx.periodEndLabel ?? period}`,
      };
    case "usage_spike":
      return {
        ...base,
        kind: "billing_usage_spike",
        severity: "warning",
        title: "Usage is running higher than last month",
        bodyMd: `${ctx.tasks.toLocaleString()} tasks so far — on track to exceed last month. Estimated invoice ${dollars(ctx.estimatedCents)}.`,
        dedupKey: `billing:usage_spike:${period}`,
      };
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function currentPeriodStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function previousPeriodStartUtc(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
    .toISOString()
    .slice(0, 10);
}

function daysInUtcMonth(now: Date): number {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
}

function formatPeriodEnd(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
