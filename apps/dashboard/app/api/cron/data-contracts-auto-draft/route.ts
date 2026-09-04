import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import {
  publicAutoDraftCronSummary,
  runAutoDraftCronJob,
} from "../../../../lib/data-contracts/auto-draft";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
// Auto-draft samples + infers for every source without a map. Same
// budget envelope as the drift cron — both walk a similar set of work.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Vercel-cron-fired endpoint that auto-creates draft Data Contracts for
 * sources that don't yet have one. Configured in
 * apps/dashboard/vercel.json under "crons".
 *
 * Auth: same dual-path as the drift cron — bearer CRON_SECRET (set by
 * Vercel automatically on scheduled invocations) or x-axel-ops-token
 * (for manual triggering during debugging). Both env vars unset = 401.
 */
import { isCronAuthorized } from "../../../../lib/cron-auth";

const authorized = isCronAuthorized;

async function handle(request: Request): Promise<Response> {
  if (!authorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const sentry = sentryClientFromEnv(process.env, "dashboard");
  try {
    const summary = await withCronCheckIn(
      sentry,
      {
        slug: "data-contracts-auto-draft",
        monitorConfig: {
          schedule: { type: "crontab", value: "*/30 * * * *" },
          checkin_margin: 5,
          max_runtime: 5,
          timezone: "UTC",
        },
      },
      async () => {
        const s = await runAutoDraftCronJob();
        if (s.errors.length > 0) {
          for (const error of s.errors.slice(0, 20)) {
            await captureDashboardException(
              new Error("data_contracts_auto_draft_item_failed"),
              {
                level: "warning",
                tags: {
                  component: "data_contracts_auto_draft_cron",
                  error_code: error.code,
                },
              },
            );
          }
        }
        return publicAutoDraftCronSummary(s);
      },
    );
    return Response.json({ ok: true, summary });
  } catch {
    await captureDashboardException(new Error("data_contracts_auto_draft_failed"), {
      tags: { component: "data_contracts_auto_draft_cron", phase: "job" },
    });
    return Response.json(
      { ok: false, error: "data_contracts_auto_draft_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
