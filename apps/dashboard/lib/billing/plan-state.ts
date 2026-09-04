import "server-only";
import type { WorkspacePlanGate, WorkspacePlanState } from "@axel/shared";
import type { Queryable } from "../db";
import { db } from "../db";
import { FREE_TIER_TASK_CAP } from "./state";
import { hasStripeConfigured } from "./stripe-client";

/**
 * Compute + push billing gates to the ingest worker.
 *
 * Gate semantics (axelapp.ai/pricing):
 *   - billing_status='suspended' or 'canceled' → reject_suspended
 *     (402 at ingest, regardless of plan).
 *   - plan='free' AND tasks_this_period >= FREE_TIER_TASK_CAP →
 *     reject_quota (429 at ingest).
 *   - Otherwise → accept. Pro overage is REPORTED to Stripe, not
 *     blocked.
 *
 * The dashboard calls these helpers after the hourly rollup (PR-2)
 * and on every Stripe subscription/invoice webhook (PR-3) so the
 * ingest worker's KV converges within seconds of any state change.
 * The worker's KV TTL (5 min) is the safety net for any missed push.
 */

export interface PlanStateRow {
  workspace_id: string;
  plan: "free" | "pro" | "enterprise";
  billing_status: "ok" | "past_due" | "grace" | "suspended" | "canceled";
  total_tasks: number;
  /**
   * Super-admin comp: bypass all billing enforcement (migration 0057).
   * Optional + fail-safe — absent/undefined means NOT exempt (billed normally).
   */
  billing_exempt?: boolean;
}

export function deriveGate(
  row: PlanStateRow,
  billingConfigured: boolean = hasStripeConfigured(),
): WorkspacePlanGate {
  // Stripe-less deployments (self-hosted, local dev) have no paid plan to
  // upgrade to, so enforcing the free-tier cap would hard-block ingest with
  // no way out. No Stripe → every workspace is unlimited. Suspension is
  // unreachable too: only Stripe webhooks write billing_status='suspended'.
  if (!billingConfigured) {
    return "accept";
  }
  // Comped workspaces bypass every gate — no card, no quota, no suspension.
  if (row.billing_exempt) {
    return "accept";
  }
  if (row.billing_status === "suspended" || row.billing_status === "canceled") {
    return "reject_suspended";
  }
  if (row.plan === "free" && row.total_tasks >= FREE_TIER_TASK_CAP) {
    return "reject_quota";
  }
  return "accept";
}

export function buildPlanState(row: PlanStateRow, now: Date = new Date()): WorkspacePlanState {
  return {
    workspace_id: row.workspace_id,
    plan: row.plan,
    gate: deriveGate(row),
    computed_at: now.toISOString(),
  };
}

export interface ComputePlanStateDeps {
  pg?: Queryable;
}

/**
 * Compute the gate for a single workspace by reading its current
 * plan + billing_status + (current period) total_tasks. Returns null
 * when the workspace doesn't exist.
 */
export async function computePlanState(
  workspaceId: string,
  deps: ComputePlanStateDeps = {},
): Promise<WorkspacePlanState | null> {
  const pg = deps.pg ?? db();
  const periodStart = currentPeriodStartUtc();
  const { rows } = await pg.query<{
    workspace_id: string;
    plan: PlanStateRow["plan"];
    billing_status: PlanStateRow["billing_status"];
    total_tasks: string | null;
    billing_exempt: boolean;
  }>(
    `SELECT w.id           AS workspace_id,
            w.plan,
            w.billing_status,
            COALESCE(w.billing_exempt, false) AS billing_exempt,
            up.total_tasks::text AS total_tasks
       FROM workspaces w
       LEFT JOIN workspace_usage_period up
         ON up.workspace_id = w.id AND up.period_start = $2::date
      WHERE w.id = $1
      LIMIT 1`,
    [workspaceId, periodStart],
  );
  const row = rows[0];
  if (!row) return null;
  return buildPlanState({
    workspace_id: row.workspace_id,
    plan: row.plan,
    billing_status: row.billing_status,
    total_tasks: parseCount(row.total_tasks),
    billing_exempt: row.billing_exempt,
  });
}

/**
 * Compute gates for every workspace in a single SQL query. Used by
 * the hourly rollup to push fresh state for the whole platform after
 * each ClickHouse aggregation.
 */
export async function computeAllPlanStates(
  deps: ComputePlanStateDeps = {},
): Promise<WorkspacePlanState[]> {
  const pg = deps.pg ?? db();
  const periodStart = currentPeriodStartUtc();
  const { rows } = await pg.query<{
    workspace_id: string;
    plan: PlanStateRow["plan"];
    billing_status: PlanStateRow["billing_status"];
    total_tasks: string | null;
    billing_exempt: boolean;
  }>(
    `SELECT w.id           AS workspace_id,
            w.plan,
            w.billing_status,
            COALESCE(w.billing_exempt, false) AS billing_exempt,
            up.total_tasks::text AS total_tasks
       FROM workspaces w
       LEFT JOIN workspace_usage_period up
         ON up.workspace_id = w.id AND up.period_start = $1::date
      WHERE w.status = 'active'`,
    [periodStart],
  );
  const now = new Date();
  return rows.map((r) =>
    buildPlanState(
      {
        workspace_id: r.workspace_id,
        plan: r.plan,
        billing_status: r.billing_status,
        total_tasks: parseCount(r.total_tasks),
        billing_exempt: r.billing_exempt,
      },
      now,
    ),
  );
}

export interface PushPlanStateDeps {
  /** Fetch implementation, defaults to global fetch. Used by tests. */
  fetch?: typeof fetch;
}

export interface PushPlanStateSummary {
  pushed: number;
  errors: number;
  skipped: number;
}

/**
 * POST each plan state to the ingest worker's /admin/workspace-plan/put
 * endpoint. Idempotent — the worker upserts by workspace_id.
 *
 * Concurrency: serial. The volume is bounded by active workspaces and
 * the worker's KV write rate (1k/s per namespace), so serial is fine
 * for hundreds of workspaces. We can batch with Promise.all when it
 * matters.
 */
export async function pushPlanStates(
  states: WorkspacePlanState[],
  deps: PushPlanStateDeps = {},
): Promise<PushPlanStateSummary> {
  const ingestAdminUrl = process.env.INGEST_ADMIN_URL;
  const ingestAdminToken = process.env.INGEST_ADMIN_TOKEN;
  if (!ingestAdminUrl || !ingestAdminToken) {
    // Without an admin URL configured, the dashboard can't push at
    // all — the worker's TTL becomes the only refresh mechanism.
    // Don't error: a deployment with no edge KV simply gets weaker
    // enforcement.
    return { pushed: 0, errors: 0, skipped: states.length };
  }

  // Derive the plan-put URL from INGEST_ADMIN_URL the same way
  // edge-invalidation does: strip a trailing source admin path if present
  // (the value may be a bare base), then append the plan path. The old
  // single-replace silently no-op'd on a bare base URL, POSTing plan state to
  // the wrong URL → 404 → suspended/over-cap workspaces kept ingesting until
  // the KV TTL, with no signal (audit).
  const base = ingestAdminUrl
    .replace(/\/admin\/(?:source-cache\/(?:invalidate|put)|source-authority\/(?:fence|sync))\/?$/, "")
    .replace(/\/$/, "");
  const planUrl = `${base}/admin/workspace-plan/put`;
  const fetchImpl = deps.fetch ?? fetch;

  let pushed = 0;
  let errors = 0;
  for (const state of states) {
    try {
      const res = await fetchImpl(planUrl, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-axel-admin-token": ingestAdminToken,
        },
        // ttl_seconds must outlive the cron interval (hourly = 3600s) or
        // free-tier workspaces over the cap experience ~55 min/hour of
        // permissive accept — the worker's permissive-on-miss policy
        // kicks in once the entry expires. 7200 = 2h gives ample headroom
        // for a missed cron run before enforcement lapses.
        body: JSON.stringify({ workspace_id: state.workspace_id, state, ttl_seconds: 7200 }),
      });
      if (res.ok || res.status === 204) {
        pushed += 1;
      } else {
        errors += 1;
      }
    } catch {
      errors += 1;
    }
  }
  return { pushed, errors, skipped: 0 };
}

function currentPeriodStartUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function parseCount(input: string | null): number {
  if (input == null) return 0;
  const n = Number(input);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
