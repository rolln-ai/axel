import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import { runNudgeScan } from "../../../../lib/nudges";
import { isCronAuthorized } from "../../../../lib/cron-auth";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Weekly best-practice nudge sweep — emits gentle, info-severity notifications
 * (e.g. "destination repeatedly failing") that ride the daily digest. Scheduled
 * in apps/dashboard/vercel.json. Same dual-auth as the other crons.
 */
async function handle(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const sentry = sentryClientFromEnv(process.env, "dashboard");
  try {
    const summary = await withCronCheckIn(
      sentry,
      {
        slug: "nudges",
        monitorConfig: {
          schedule: { type: "crontab", value: "0 15 * * 1" },
          checkin_margin: 10,
          max_runtime: 5,
          timezone: "UTC",
        },
      },
      async () => runNudgeScan(),
    );
    return Response.json({ ok: true, summary });
  } catch (err) {
    await captureDashboardException(err, {
      tags: { component: "nudges_cron", phase: "job" },
    });
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
