import "server-only";
import type Stripe from "stripe";
import { db, withTransaction, type Queryable } from "./db";
import { wipeWorkspaceData, type WorkspaceDataWipeOptions } from "./data-reset";
import { hasStripeConfigured } from "./billing/stripe-client";
import { flushWorkspaceMeterUsage } from "./billing/meter-reporter";
import { cancelSubscriptionWithFinalInvoice } from "./billing/cancellation";

/**
 * Out-of-band teardown of workspaces the user flipped to `status = 'deleting'`.
 *
 * Self-serve deletion used to run the whole teardown inline in the server
 * action — thousands of per-object R2 deletes + synchronous ClickHouse
 * mutations — which hung the UI for minutes and could exceed the 300s function
 * limit, leaving a half-wiped shell. The action now just marks `deleting` and
 * redirects; this sweep (driven by the workspace-teardown cron) does the work.
 *
 * Per workspace, staged across sweeps so each step is bounded and idempotent:
 *   1. flush  — report the final period usage to the Stripe meter (while the
 *               ClickHouse data still exists), stamp usage_flushed_at.
 *   2. settle — wait FLUSH_SETTLE_MS for the meter to aggregate.
 *   3. cancel — cancel the subscription with a final invoice for that usage,
 *               then wipe external stores and hard-delete the row.
 * Free workspaces (no subscription) skip 1–3 and go straight to wipe + delete.
 */

// FK-less, workspace-scoped tables the DELETE cascade can't reach. Mirrors the
// list in deleteCurrentWorkspace; erasure_requests is intentionally NOT here (it
// is the GDPR proof-of-erasure trail and must outlive the workspace).
const NON_CASCADING_TABLES = ["dead_letters", "delivery_idempotency", "erasure_subjects"] as const;

// Let the Stripe meter aggregate flushed usage before canceling so the final
// invoice bills every event. The cron runs every 5 min, so this clears in one
// cycle; the guard mainly protects manual/back-to-back sweeps.
const FLUSH_SETTLE_MS = 2 * 60 * 1000;

// Bound per-sweep work so a run can't blow the function's maxDuration; the rest
// are picked up next tick. Oldest-first so nothing starves.
const SWEEP_BATCH = 5;
// Keep a full minute of headroom under the route's 300-second hard stop for
// Sentry close-out, response serialization, and a single slow platform call.
const SWEEP_TIME_BUDGET_MS = 4 * 60 * 1000;
const SWEEP_MIN_REMAINING_MS = 15_000;

export type TeardownStage = "flushed" | "settling" | "canceled" | "wiping" | "deleted" | "error";

export interface TeardownResult {
  workspaceId: string;
  stage: TeardownStage;
  detail?: string;
}

export interface WorkspaceTeardownSweepSummary {
  swept: number;
  results: TeardownResult[];
}

/**
 * Raised after a best-effort sweep finishes when one or more workspaces could
 * not advance. The completed results are retained for logs/tests, while the
 * rejection makes the cron's HTTP response and Sentry check-in fail instead of
 * reporting a false green run.
 */
export class WorkspaceTeardownSweepError extends Error {
  readonly summary: WorkspaceTeardownSweepSummary;

  constructor(summary: WorkspaceTeardownSweepSummary) {
    const failures = summary.results.filter((result) => result.stage === "error");
    const details = failures
      .map((failure) => `${failure.workspaceId}: ${failure.detail ?? "unknown error"}`)
      .join("; ");
    super(
      `Workspace teardown failed for ${failures.length} of ${summary.swept} workspace(s)${
        details ? ` (${details})` : ""
      }`,
    );
    this.name = "WorkspaceTeardownSweepError";
    this.summary = summary;
  }
}

export interface WorkspaceTeardownDeps {
  now?: Date;
  /** Absolute deadline override for tests/single-workspace operator retries. */
  deadlineMs?: number;
  pg?: Queryable;
  stripe?: Pick<Stripe, "billing" | "subscriptions">;
  wipeDeps?: WorkspaceDataWipeOptions["deps"];
}

interface DeletingRow {
  id: string;
  plan: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  usage_flushed_at: string | null;
}

export async function sweepWorkspaceTeardowns(
  deps: WorkspaceTeardownDeps = {},
): Promise<WorkspaceTeardownSweepSummary> {
  const pg = deps.pg ?? db();
  const { rows } = await pg.query<DeletingRow>(
    `SELECT id, plan, stripe_customer_id, stripe_subscription_id,
            usage_flushed_at::text AS usage_flushed_at
       FROM workspaces
      WHERE status = 'deleting'
      ORDER BY deleted_at ASC NULLS FIRST
      LIMIT ${SWEEP_BATCH}`,
  );

  const deadlineMs = deps.deadlineMs ?? Date.now() + SWEEP_TIME_BUDGET_MS;
  const results: TeardownResult[] = [];
  for (const ws of rows) {
    if (Date.now() + SWEEP_MIN_REMAINING_MS >= deadlineMs) break;
    try {
      results.push(await teardownWorkspace(ws, { ...deps, deadlineMs }));
    } catch (err) {
      // Best-effort per workspace: a failure leaves it 'deleting' for the next
      // sweep to retry (every step is idempotent). Surface for operator logs.
      console.error(`[workspace-teardown] ${ws.id} failed:`, err);
      results.push({
        workspaceId: ws.id,
        stage: "error",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const summary = { swept: results.length, results };
  if (results.some((result) => result.stage === "error")) {
    throw new WorkspaceTeardownSweepError(summary);
  }
  return summary;
}

/**
 * Run one teardown step for a single `deleting` workspace, out-of-band from the
 * sweep. Used by the super-admin "Retry teardown" action to unstick a workspace
 * the cron keeps failing on — and, unlike the cron, it surfaces the actual
 * error instead of swallowing it. Returns stage `error` (never throws) so the
 * caller can render the reason. Idempotent + staged like the sweep, so a
 * subscription-bearing workspace may need a couple of clicks to fully drain.
 */
export async function teardownSingleWorkspace(
  workspaceId: string,
  deps: WorkspaceTeardownDeps = {},
): Promise<TeardownResult> {
  const pg = deps.pg ?? db();
  const { rows } = await pg.query<DeletingRow>(
    `SELECT id, plan, stripe_customer_id, stripe_subscription_id,
            usage_flushed_at::text AS usage_flushed_at
       FROM workspaces
      WHERE id = $1 AND status = 'deleting'
      LIMIT 1`,
    [workspaceId],
  );
  const ws = rows[0];
  if (!ws) {
    return { workspaceId, stage: "error", detail: "not found, or not in 'deleting' status" };
  }
  try {
    return await teardownWorkspace(ws, deps);
  } catch (err) {
    return { workspaceId, stage: "error", detail: err instanceof Error ? err.message : String(err) };
  }
}

async function teardownWorkspace(
  ws: DeletingRow,
  deps: WorkspaceTeardownDeps,
): Promise<TeardownResult> {
  const pg = deps.pg ?? db();
  const now = deps.now ?? new Date();

  // ── Billing: only for a workspace that still has a live subscription. ──
  if (ws.stripe_subscription_id && (deps.stripe || hasStripeConfigured())) {
    if (!ws.usage_flushed_at) {
      // Report the final period usage while ClickHouse still holds the data;
      // then wait a cycle for the meter to aggregate before canceling.
      let detail: string | undefined;
      if (ws.stripe_customer_id) {
        try {
          await flushWorkspaceMeterUsage(
            { workspaceId: ws.id, stripeCustomerId: ws.stripe_customer_id },
            {
              now,
              ...(deps.stripe ? { stripe: deps.stripe } : {}),
              ...(deps.wipeDeps?.clickhouse ? { ch: deps.wipeDeps.clickhouse } : {}),
            },
          );
        } catch (err) {
          // A deleted Stripe customer cannot receive meter events and will
          // never recover on retry. Treat only a positively identified missing
          // customer as already gone; every other Stripe failure still aborts
          // the stage so transient/configuration errors cannot drop billing.
          if (!isMissingStripeCustomerError(err, ws.stripe_customer_id)) throw err;
          detail = "Stripe customer already deleted; skipped final usage flush";
          console.warn(`[workspace-teardown] ${ws.id}: ${detail}`);
        }
      }
      await pg.query("UPDATE workspaces SET usage_flushed_at = now() WHERE id = $1", [ws.id]);
      return { workspaceId: ws.id, stage: "flushed", ...(detail ? { detail } : {}) };
    }
    const settledMs = now.getTime() - new Date(ws.usage_flushed_at).getTime();
    if (settledMs < FLUSH_SETTLE_MS) {
      return { workspaceId: ws.id, stage: "settling" };
    }
    // Cancel with a final invoice for the reported usage, then null the id so a
    // retry (or the customer.subscription.deleted webhook) doesn't re-cancel.
    await cancelSubscriptionWithFinalInvoice(
      ws.stripe_subscription_id,
      deps.stripe ? { stripe: deps.stripe } : {},
    );
    await pg.query(
      "UPDATE workspaces SET stripe_subscription_id = NULL, plan = 'free', billing_status = 'canceled' WHERE id = $1",
      [ws.id],
    );
    // fall through to wipe + delete in the same run
  }

  // ── Wipe external stores (ClickHouse + R2). Idempotent; retriable. ──
  const wiped = await wipeWorkspaceData(ws.id, {
    includeRawPayloads: true,
    deps: {
      ...(deps.wipeDeps ?? {}),
      pg,
      ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}),
    },
  });
  if (wiped.r2LimitReached) {
    return {
      workspaceId: ws.id,
      stage: "wiping",
      detail: `Deleted ${wiped.r2Deleted} raw payload object(s); more remain`,
    };
  }
  if (wiped.postgresLimitReached) {
    return {
      workspaceId: ws.id,
      stage: "wiping",
      detail: `Deleted ${wiped.postgresRows} operational row(s); more remain`,
    };
  }
  if (wiped.clickhouseLimitReached) {
    return {
      workspaceId: ws.id,
      stage: "wiping",
      detail: `ClickHouse deletion pending${
        wiped.clickhouseTables.length > 0 ? ` for ${wiped.clickhouseTables.join(", ")}` : ""
      }`,
    };
  }

  // ── Hard delete: FK cascade sweeps dependent rows; reap the FK-less tables. ──
  await withTransaction(async (client) => {
    await client.query("DELETE FROM workspaces WHERE id = $1", [ws.id]);
    for (const table of NON_CASCADING_TABLES) {
      await client.query(`DELETE FROM ${table} WHERE workspace_id = $1`, [ws.id]);
    }
  });
  return { workspaceId: ws.id, stage: "deleted" };
}

function isMissingStripeCustomerError(err: unknown, customerId: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    statusCode?: number;
    message?: string;
    param?: string;
    raw?: { code?: string; statusCode?: number; message?: string; param?: string };
  };
  const code = e.code ?? e.raw?.code;
  const statusCode = e.statusCode ?? e.raw?.statusCode;
  if (code !== "resource_missing" && statusCode !== 404) return false;

  const message = (e.message ?? e.raw?.message ?? "").toLowerCase();
  const param = (e.param ?? e.raw?.param ?? "").toLowerCase();
  const normalizedCustomerId = customerId.toLowerCase();
  return (
    message.includes("no such customer") ||
    (message.includes("customer") && message.includes(normalizedCustomerId)) ||
    param.includes("stripe_customer_id") ||
    param === "customer"
  );
}
