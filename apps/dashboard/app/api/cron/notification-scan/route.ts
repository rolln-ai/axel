import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import { runImpactAlertScan } from "../../../../lib/impact-alerts";
import { isCronAuthorized } from "../../../../lib/cron-auth";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

async function handle(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const sentry = sentryClientFromEnv(process.env, "dashboard");
  try {
    const summary = await withCronCheckIn(
      sentry,
      {
        slug: "notification-scan",
        monitorConfig: {
          schedule: { type: "crontab", value: "*/15 * * * *" },
          checkin_margin: 5,
          max_runtime: 5,
          timezone: "UTC",
          failure_issue_threshold: 2,
          recovery_threshold: 1,
        },
      },
      async () => {
        const summary = await runImpactAlertScan();
        if (summary.monitor_unavailable || summary.failed || summary.needs_review) {
          await captureDashboardException(new Error("impact_alert_scan_incomplete"), {
            level: "error", tags: { component: "notification_scan_cron" },
          });
          // A failed monitor check must fail its external heartbeat too.
          throw new Error("impact_alert_scan_incomplete");
        }
        return summary;
      },
    );
    return Response.json({ ok: true, summary });
  } catch {
      await captureDashboardException(new Error("notification_scan_failed"), {
        tags: { component: "notification_scan_cron", phase: "job" },
      });
    return Response.json(
      { ok: false, error: "notification_scan_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
