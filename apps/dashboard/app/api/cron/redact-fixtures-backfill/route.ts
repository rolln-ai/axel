import { isCronAuthorized } from "../../../../lib/cron-auth";
import { backfillRedactFixtures } from "../../../../lib/data-contracts/fixture-redaction-backfill";
import { captureDashboardException } from "../../../../lib/sentry-capture";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * One-time maintenance: mask PII in already-stored data_contract_fixtures
 * (input_payload + expected_output). Idempotent, so it is safe to call more than
 * once; if `done` is false (row cap hit), call again to continue.
 *
 * Not scheduled in vercel.json — triggered manually:
 *   curl -X POST https://app.axelapp.ai/api/cron/redact-fixtures-backfill \
 *     -H "Authorization: Bearer $CRON_SECRET"
 *
 * Auth: same dual-token pattern as the other crons (Bearer CRON_SECRET or
 * x-axel-ops-token).
 */
async function handle(request: Request): Promise<Response> {
  if (!isCronAuthorized(request)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await backfillRedactFixtures();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    captureDashboardException(err, { tags: { component: "redact_fixtures_backfill" } });
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "backfill_failed" },
      { status: 500 },
    );
  }
}

export const POST = handle;
