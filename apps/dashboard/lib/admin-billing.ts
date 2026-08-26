import "server-only";
import { db } from "./db";
import { estimateInvoiceCentsFor, PRO_INCLUDED_TASKS } from "./billing/state";

/**
 * Cross-workspace billing queries for the super-admin section. Like
 * admin-queries.ts, every function here is intentionally
 * workspace-unscoped (no `workspace_id = $1` predicate) and is only
 * callable from routes that have passed `requireSuperAdmin()`.
 *
 * The /admin/overview tiles and the /admin/billing list both render
 * from these aggregates without round-tripping to Stripe.
 */

export interface BillingOverviewTotals {
  /** Active Pro subscriptions. */
  activeProCount: number;
  /** Workspaces in past_due / suspended / canceled — needs ops attention. */
  attentionCount: number;
  /** Sum of estimated next-invoice cents across active Pro workspaces (this period). */
  mrrCentsEstimate: number;
  /** Sum of all billable tasks for active Pro workspaces this period. */
  tasksThisPeriod: number;
  /** Sum of overage-only revenue in cents above the inbound usage credit. */
  overageCentsEstimate: number;
  /** Free workspaces currently over their 10k cap (currently being 429'd). */
  freeWorkspacesOverCap: number;
}

export async function getBillingOverviewTotals(): Promise<BillingOverviewTotals> {
  const periodStart = currentPeriodStartUtc();
  const { rows } = await db().query<{
    active_pro_count: string;
    attention_count: string;
    tasks_this_period: string;
    pro_tasks_this_period: string;
    overage_tasks: string;
    free_over_cap: string;
  }>(
    `WITH ws AS (
       SELECT w.id, w.plan, w.billing_status,
              COALESCE(up.total_tasks, 0)::bigint AS total_tasks
         FROM workspaces w
         LEFT JOIN workspace_usage_period up
           ON up.workspace_id = w.id AND up.period_start = $1::date
        WHERE w.status = 'active'
     )
     SELECT
       COUNT(*) FILTER (WHERE plan = 'pro' AND billing_status = 'ok')::text AS active_pro_count,
       COUNT(*) FILTER (WHERE billing_status IN ('past_due','suspended','canceled','grace'))::text AS attention_count,
       COALESCE(SUM(total_tasks) FILTER (WHERE plan = 'pro'), 0)::text AS pro_tasks_this_period,
       COALESCE(SUM(total_tasks), 0)::text AS tasks_this_period,
       COALESCE(SUM(GREATEST(0, total_tasks - ${PRO_INCLUDED_TASKS})) FILTER (WHERE plan = 'pro'), 0)::text AS overage_tasks,
       COUNT(*) FILTER (WHERE plan = 'free' AND total_tasks >= 10000)::text AS free_over_cap
     FROM ws`,
    [periodStart],
  );
  const r = rows[0] ?? {
    active_pro_count: "0",
    attention_count: "0",
    tasks_this_period: "0",
    pro_tasks_this_period: "0",
    overage_tasks: "0",
    free_over_cap: "0",
  };
  const activeProCount = Number(r.active_pro_count);
  // Each active Pro contributes $20 base (2000 cents) + their own overage.
  const baseCents = activeProCount * 2000;
  const overageCents = Math.ceil((Number(r.overage_tasks) * 15) / 10_000);
  return {
    activeProCount,
    attentionCount: Number(r.attention_count),
    mrrCentsEstimate: baseCents + overageCents,
    tasksThisPeriod: Number(r.tasks_this_period),
    overageCentsEstimate: overageCents,
    freeWorkspacesOverCap: Number(r.free_over_cap),
  };
}

export interface AdminBillingWorkspaceRow {
  workspace_id: string;
  workspace_name: string;
  plan: "free" | "pro" | "enterprise";
  billing_status: "ok" | "past_due" | "grace" | "suspended" | "canceled";
  stripe_customer_id: string | null;
  total_tasks: number;
  billing_period_start: string | null;
  billing_period_end: string | null;
  reported_to_stripe_at: string | null;
  owner_email: string | null;
  invoice_count: number;
  last_invoice_status: string | null;
  estimated_next_invoice_cents: number;
}

export interface ListAdminBillingOptions {
  status?: "all" | "ok" | "past_due" | "grace" | "suspended" | "canceled";
  plan?: "all" | "free" | "pro" | "enterprise";
  search?: string;
  limit?: number;
}

export async function listAdminBillingWorkspaces(
  opts: ListAdminBillingOptions = {},
): Promise<AdminBillingWorkspaceRow[]> {
  const periodStart = currentPeriodStartUtc();
  const limit = Math.min(500, Math.max(10, opts.limit ?? 200));
  const status = opts.status && opts.status !== "all" ? opts.status : null;
  const plan = opts.plan && opts.plan !== "all" ? opts.plan : null;
  const search = opts.search?.trim() || null;

  const { rows } = await db().query<{
    workspace_id: string;
    workspace_name: string;
    plan: AdminBillingWorkspaceRow["plan"];
    billing_status: AdminBillingWorkspaceRow["billing_status"];
    stripe_customer_id: string | null;
    total_tasks: string;
    billing_period_start: string | null;
    billing_period_end: string | null;
    reported_to_stripe_at: string | null;
    owner_email: string | null;
    invoice_count: string;
    last_invoice_status: string | null;
  }>(
    `SELECT w.id AS workspace_id,
            w.name AS workspace_name,
            w.plan,
            w.billing_status,
            w.stripe_customer_id,
            COALESCE(up.total_tasks, 0)::text AS total_tasks,
            w.billing_period_start::text AS billing_period_start,
            w.billing_period_end::text AS billing_period_end,
            up.reported_to_stripe_at::text AS reported_to_stripe_at,
            owner.email AS owner_email,
            COALESCE(inv.invoice_count, 0)::text AS invoice_count,
            inv.last_status AS last_invoice_status
       FROM workspaces w
       LEFT JOIN workspace_usage_period up
         ON up.workspace_id = w.id AND up.period_start = $1::date
       LEFT JOIN LATERAL (
         SELECT u.email
           FROM workspace_members wm
           JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = w.id AND wm.role = 'owner'
          ORDER BY wm.created_at ASC
          LIMIT 1
       ) owner ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS invoice_count,
                (SELECT status FROM billing_invoices
                  WHERE workspace_id = w.id ORDER BY created_at DESC LIMIT 1) AS last_status
           FROM billing_invoices
          WHERE workspace_id = w.id
       ) inv ON true
      WHERE w.status = 'active'
        AND ($2::text IS NULL OR w.billing_status = $2)
        AND ($3::text IS NULL OR w.plan = $3)
        AND (
          $4::text IS NULL
          OR w.name ILIKE '%' || $4 || '%'
          OR w.id ILIKE '%' || $4 || '%'
          OR owner.email ILIKE '%' || $4 || '%'
        )
      ORDER BY
        CASE w.billing_status
          WHEN 'suspended' THEN 0
          WHEN 'past_due'  THEN 1
          WHEN 'grace'     THEN 2
          ELSE 3
        END,
        COALESCE(up.total_tasks, 0) DESC,
        w.name ASC
      LIMIT $5`,
    [periodStart, status, plan, search, limit],
  );

  return rows.map((r) => {
    const totalTasks = Number(r.total_tasks);
    const estimateCents = estimateInvoiceCents(r.plan, totalTasks);
    return {
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      plan: r.plan,
      billing_status: r.billing_status,
      stripe_customer_id: r.stripe_customer_id,
      total_tasks: totalTasks,
      billing_period_start: r.billing_period_start,
      billing_period_end: r.billing_period_end,
      reported_to_stripe_at: r.reported_to_stripe_at,
      owner_email: r.owner_email,
      invoice_count: Number(r.invoice_count),
      last_invoice_status: r.last_invoice_status,
      estimated_next_invoice_cents: estimateCents,
    };
  });
}

export interface AdminBillingEventRow {
  id: string;
  type: string;
  workspace_id: string | null;
  workspace_name: string | null;
  received_at: string;
  processed_at: string | null;
  error: string | null;
}

export async function listRecentBillingEvents(limit = 50): Promise<AdminBillingEventRow[]> {
  const { rows } = await db().query<{
    id: string;
    type: string;
    workspace_id: string | null;
    workspace_name: string | null;
    received_at: string;
    processed_at: string | null;
    error: string | null;
  }>(
    `SELECT be.id,
            be.type,
            be.workspace_id,
            w.name AS workspace_name,
            be.received_at::text,
            be.processed_at::text,
            be.error
       FROM billing_events be
       LEFT JOIN workspaces w ON w.id = be.workspace_id
      ORDER BY be.received_at DESC
      LIMIT $1`,
    [Math.min(200, Math.max(10, limit))],
  );
  return rows;
}

export interface AdminInvoiceRow {
  id: string;
  workspace_id: string;
  workspace_name: string | null;
  status: string;
  total_cents: number;
  currency: string;
  hosted_url: string | null;
  pdf_url: string | null;
  created_at: string;
  period_start: string | null;
  period_end: string | null;
}

export async function listWorkspaceInvoices(
  workspaceId: string,
  limit = 25,
): Promise<AdminInvoiceRow[]> {
  const { rows } = await db().query<{
    id: string;
    workspace_id: string;
    workspace_name: string | null;
    status: string;
    total_cents: number;
    currency: string;
    hosted_url: string | null;
    pdf_url: string | null;
    created_at: string;
    period_start: string | null;
    period_end: string | null;
  }>(
    `SELECT bi.id,
            bi.workspace_id,
            w.name AS workspace_name,
            bi.status,
            bi.total_cents,
            bi.currency,
            bi.hosted_url,
            bi.pdf_url,
            bi.created_at::text,
            bi.period_start::text,
            bi.period_end::text
       FROM billing_invoices bi
       LEFT JOIN workspaces w ON w.id = bi.workspace_id
      WHERE bi.workspace_id = $1
      ORDER BY bi.created_at DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows;
}

function estimateInvoiceCents(plan: string, totalTasks: number): number {
  return estimateInvoiceCentsFor(
    plan === "free" || plan === "pro" || plan === "enterprise" ? plan : "free",
    totalTasks,
  );
}

function currentPeriodStartUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}
