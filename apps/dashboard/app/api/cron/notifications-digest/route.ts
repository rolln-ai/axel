import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import { runDigestJob } from "../../../../lib/data-contracts/email-digest";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Daily digest cron — emails workspace members a summary of Axel
 * notifications from the last 24h. Scheduled in vercel.json. Same
 * dual-auth pattern as the other crons (Bearer CRON_SECRET or
 * x-axel-ops-token for manual triggers).
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
        slug: "notifications-digest",
        monitorConfig: {
          schedule: { type: "crontab", value: "0 14 * * *" },
          checkin_margin: 10,
          // Must stay aligned with `maxDuration` above (5 min / 300s).
          // Otherwise Vercel kills the function before the ok check-in
          // fires, Sentry waits max_runtime then flags a phantom timeout.
          // If the digest legitimately needs more than 5 min, bump
          // `maxDuration` to 600s (Vercel Pro supports up to 800s) or
          // chunk the digest fan-out into multiple invocations.
          max_runtime: 5,
          timezone: "UTC",
        },
      },
      async () => {
        const s = await runDigestJob();
        if (s.errors.length > 0) {
          for (const err of s.errors.slice(0, 20)) {
            await captureDashboardException(
              new Error("notifications_digest_item_failed"),
              {
                level: "warning",
                tags: {
                  component: "notifications_digest_cron",
                  error_code: err.code,
                },
              },
            );
          }
        }
        return s;
      },
    );
    return Response.json({ ok: true, summary });
  } catch {
    await captureDashboardException(new Error("notifications_digest_failed"), {
      tags: { component: "notifications_digest_cron", phase: "job" },
    });
    return Response.json(
      { ok: false, error: "notifications_digest_failed" },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
