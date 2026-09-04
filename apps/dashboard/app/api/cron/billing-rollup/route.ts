import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import { dispatchBillingEmails } from "../../../../lib/billing/email-dispatcher";
import { reportMeterEvents } from "../../../../lib/billing/meter-reporter";
import { computeAllPlanStates, pushPlanStates } from "../../../../lib/billing/plan-state";
import {
  publicBillingRollupCronSummary,
  runBillingRollup,
} from "../../../../lib/billing/rollup";
import { hasStripeConfigured } from "../../../../lib/billing/stripe-client";
import { hasClickhouseUrl } from "../../../../lib/clickhouse";
import { isCronAuthorized } from "../../../../lib/cron-auth";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Hourly billing rollup. Recomputes the current calendar-month
 * per-workspace task totals from ClickHouse and upserts them into
 * `workspace_usage_period`. See lib/billing/rollup.ts for the task
 * definition. Scheduled in apps/dashboard/vercel.json.
 *
 * When Stripe is configured, also forwards each Pro workspace's
 * previous-day task count to the Stripe Meter so invoices accumulate
 * correctly. Meter events are deduplicated by Stripe via the
 * (workspace_id:day) identifier, so duplicate firings or backfills
 * are safe.
 *
 * Auth: same dual-token pattern as the other crons — Bearer
 * CRON_SECRET (Vercel) or x-axel-ops-token (manual triggers during
 * incident response or backfill).
 */
async function handle(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const sentry = sentryClientFromEnv(process.env, "dashboard");
  try {
    const result = await withCronCheckIn(
      sentry,
      {
        slug: "billing-rollup",
        monitorConfig: {
          schedule: { type: "crontab", value: "0 * * * *" },
          checkin_margin: 5,
          max_runtime: 5,
          timezone: "UTC",
        },
      },
      async () => {
        // Self-hosted deployments may run without ClickHouse; skip the usage
        // aggregation but still push plan gates so the edge KV stays fresh.
        let summary: Awaited<ReturnType<typeof runBillingRollup>> | { skipped: "clickhouse_not_configured" };
        if (hasClickhouseUrl()) {
          summary = await runBillingRollup();
        } else {
          summary = { skipped: "clickhouse_not_configured" };
        }
        let meter: Awaited<ReturnType<typeof reportMeterEvents>> | { skipped: "stripe_not_configured" };
        if (hasStripeConfigured()) {
          meter = await reportMeterEvents();
        } else {
          meter = { skipped: "stripe_not_configured" };
        }
        // Push fresh plan gates to the ingest worker so 10k-cap free
        // workspaces start 429-ing within minutes of crossing the
        // threshold, instead of waiting for the KV TTL (5 min) to expire
        // on a stale "accept" entry.
        const states = await computeAllPlanStates();
        const planPush = await pushPlanStates(states);
        // Fire notice emails for workspaces that crossed a threshold this
        // hour. sendBillingEmail dedups via billing_events PK so this is
        // safe to call every run (only the first cross per period emails).
        const emails = await dispatchBillingEmails();
        return publicBillingRollupCronSummary({ summary, meter, planPush, emails });
      },
    );
    return Response.json({ ok: true, summary: result });
  } catch {
    await captureDashboardException(new Error("billing_rollup_failed"), {
      tags: { component: "billing_rollup_cron" },
    });
    return Response.json(
      { ok: false, error: "billing_rollup_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
