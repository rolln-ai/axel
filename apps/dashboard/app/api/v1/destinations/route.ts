/**
 * AXE-29 — REST: list destinations.
 */
import { type NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { apiOk, readPagination, withApiAuth } from "../../../../lib/api-router";

export async function GET(req: NextRequest) {
  return withApiAuth(req, "read", async (ctx) => {
    const { limit, cursor } = readPagination(req);
    const result = await db().query<{
      id: string;
      name: string | null;
      type: string;
      status: string;
      circuit_state: string;
      delivery_paused: boolean;
      created_at: string;
    }>(
      cursor
        ? `SELECT id, name, type, status, circuit_state, delivery_paused, created_at::text
             FROM destinations
            WHERE workspace_id = $1 AND id < $2
            ORDER BY id DESC
            LIMIT $3`
        : `SELECT id, name, type, status, circuit_state, delivery_paused, created_at::text
             FROM destinations
            WHERE workspace_id = $1
            ORDER BY id DESC
            LIMIT $2`,
      cursor ? [ctx.workspace_id, cursor, limit] : [ctx.workspace_id, limit],
    );
    const nextCursor =
      result.rows.length === limit ? result.rows[result.rows.length - 1]?.id ?? null : null;
    return apiOk({ data: result.rows, meta: { limit, next_cursor: nextCursor } });
  });
}
