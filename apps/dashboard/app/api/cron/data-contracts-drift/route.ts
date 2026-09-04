import {
  sentryClientFromEnv,
  withCronCheckIn,
} from "@axel/observability";
import {
  publicDriftCronSummary,
  runDriftCronJob,
} from "../../../../lib/data-contracts/drift";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
// Drift detection touches ClickHouse + R2 + Postgres; the default
// per-page timeout would be too short for a worst-case sweep. Cron
// invocations are scheduled, never on a user request, so a longer
// budget is safe.
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Vercel-cron-fired endpoint that runs Data Contract drift detection across
 * every active map in every workspace and writes notifications into the
 * bell. Configured in apps/dashboard/vercel.json under "crons".
 *
 * Auth: Vercel sends `Authorization: Bearer <CRON_SECRET>` on every cron
 * request. We also accept the legacy `x-axel-ops-token` header so an
 * operator can fire it manually with the ops token if needed during
 * debugging. Either header alone is sufficient.
 *
 * The response intentionally omits any workspace data — it returns only
 * aggregate counts so it's safe to log/Sentry without leaking schemas
 * across workspaces.
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
        slug: "data-contracts-drift",
        monitorConfig: {
          schedule: { type: "crontab", value: "*/5 * * * *" },
          checkin_margin: 2,
          max_runtime: 4,
          timezone: "UTC",
          failure_issue_threshold: 2,
          recovery_threshold: 1,
        },
      },
      async () => {
        const s = await runDriftCronJob();
        if (s.errors.length > 0) {
          // Surface per-map failures into Sentry without failing the whole
          // job. The next cron tick will retry the maps that errored.
          for (const error of s.errors.slice(0, 20)) {
            if (error.code === "transient_platform_failure") continue;
            await captureDashboardException(
              new Error("data_contracts_drift_item_failed"),
              {
                level: "warning",
                tags: {
                  component: "data_contracts_drift_cron",
                  error_code: error.code,
                },
              },
            );
          }
        }
        return publicDriftCronSummary(s);
      },
    );
    return Response.json({ ok: true, summary });
  } catch {
    await captureDashboardException(new Error("data_contracts_drift_failed"), {
      tags: { component: "data_contracts_drift_cron", phase: "job" },
    });
    return Response.json(
      { ok: false, error: "data_contracts_drift_failed" },
      { status: 500 },
    );
  }
}

// Vercel cron uses GET; the manual-trigger flow uses POST so it can't
// be hit by an idle browser pre-fetch. Both go through the same handler.
export const GET = handle;
export const POST = handle;
