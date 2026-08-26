/**
 * AXE-29 — REST: workspace usage summary (last 30 days).
 */
import { type NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { apiOk, withApiAuth } from "../../../../lib/api-router";

export async function GET(req: NextRequest) {
  return withApiAuth(req, "read", async (ctx) => {
    const sources = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sources WHERE workspace_id = $1 AND status = 'active'`,
      [ctx.workspace_id],
    );
    const destinations = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM destinations WHERE workspace_id = $1 AND status = 'active'`,
      [ctx.workspace_id],
    );
    const deadLetters = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dead_letters
        WHERE workspace_id = $1 AND errored_at > now() - interval '30 days'`,
      [ctx.workspace_id],
    );
    return apiOk({
      data: {
        active_sources: sources.rows[0]?.n ?? 0,
        active_destinations: destinations.rows[0]?.n ?? 0,
        dead_letters_30d: deadLetters.rows[0]?.n ?? 0,
      },
    });
  });
}
