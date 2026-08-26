import { sentryClientFromEnv, withCronCheckIn } from "@axel/observability";
import { isCronAuthorized } from "../../../../lib/cron-auth";
import { captureDashboardException } from "../../../../lib/sentry-capture";
import { sweepWorkspaceTeardowns } from "../../../../lib/workspace-teardown";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Async workspace teardown. Picks up workspaces the user flipped to
 * `status = 'deleting'` and, per workspace, flushes final Stripe usage →
 * cancels the subscription → wipes ClickHouse + R2 → hard-deletes the row.
 * Staged and idempotent, so partial runs (or the 300s cap on a huge workspace)
 * just resume next tick. See lib/workspace-teardown.ts. Scheduled in vercel.json.
 *
 * Auth: same dual-token pattern as the other crons — Bearer CRON_SECRET
 * (Vercel) or x-axel-ops-token (manual triggers).
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
        slug: "workspace-teardown",
        monitorConfig: {
          schedule: { type: "crontab", value: "*/5 * * * *" },
          checkin_margin: 5,
          max_runtime: 5,
          timezone: "UTC",
        },
      },
      async () => sweepWorkspaceTeardowns(),
    );
    return Response.json({ ok: true, ...result });
  } catch (err) {
    await captureDashboardException(err, {
      tags: { component: "workspace_teardown_cron" },
    });
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
