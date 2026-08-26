import { sentryClientFromEnv } from "@axel/observability";
import { captureDashboardExceptionAndFlush } from "../../../../lib/sentry-capture";
import { resolveDashboardSentryDsn } from "../../../../lib/sentry-runtime-config";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const configuredToken = process.env.OPS_TEST_TOKEN;
  const providedToken = request.headers.get("x-axel-ops-token");
  if (!configuredToken || providedToken !== configuredToken) {
    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  }

  const mode = new URL(request.url).searchParams.get("mode");
  if (mode === "source-map") {
    const dsn = resolveDashboardSentryDsn({
      SENTRY_DSN: process.env.SENTRY_DSN,
      NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    });
    if (!dsn) {
      return Response.json({ ok: false, error: "sentry_not_configured" }, { status: 503 });
    }

    try {
      const eventId = await captureDashboardExceptionAndFlush(
        new Error("ops_sentry_source_map_probe"),
        {
          tags: {
            component: "ops_sentry_source_map",
            route: "/api/ops/sentry-test",
          },
        },
      );
      return Response.json({ ok: true, event_id: eventId });
    } catch {
      return Response.json({ ok: false, error: "sentry_source_map_failed" }, { status: 502 });
    }
  }

  const sentry = sentryClientFromEnv(process.env, "dashboard");
  if (!sentry) {
    return Response.json({ ok: false, error: "sentry_not_configured" }, { status: 503 });
  }

  try {
    // A transaction proves the envelope transport accepted this release
    // without opening a warning/error Issue on every deployment. Call the
    // client directly so transport failures reach the smoke workflow.
    await sentry.captureTransaction({
      name: "ops.sentry.transport",
      op: "ops.smoke",
      tags: {
        component: "ops_sentry_transport",
        route: "/api/ops/sentry-test",
      },
    });
  } catch {
    return Response.json({ ok: false, error: "sentry_transport_failed" }, { status: 502 });
  }

  return Response.json({ ok: true });
}
