import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import {
  runNotificationScan,
  shouldReportNotificationScanError,
} from "../../../../lib/notification-scan";
import { isCronAuthorized } from "../../../../lib/cron-auth";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Every-15-minutes scan that turns newly-appearing dead-letter fingerprints
 * into "new error type" notifications + a single immediate alert email per
 * error. Scheduled in apps/dashboard/vercel.json. Same dual-auth as the other
 * crons (Bearer CRON_SECRET, or x-axel-ops-token for manual triggers).
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
        const s = await runNotificationScan();
        if (s.errors.length > 0) {
          for (const err of s.errors.slice(0, 20)) {
            if (!shouldReportNotificationScanError(err.message)) continue;
            await captureDashboardException(
              new Error(`notification-scan: ${err.message}`),
              {
                level: "warning",
                tags: {
                  component: "notification_scan_cron",
                  workspace_id: err.workspace_id,
                },
              },
            );
          }
        }
        return s;
      },
    );
    return Response.json({ ok: true, summary });
  } catch (err) {
    if (shouldReportNotificationScanError(err)) {
      await captureDashboardException(err, {
        tags: { component: "notification_scan_cron", phase: "job" },
      });
    }
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
