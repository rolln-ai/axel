/**
 * AXE-29 — REST: list + create sources via workspace API key.
 *
 * GET  /api/v1/sources           → list (read scope)
 * POST /api/v1/sources           → create (write scope)
 */
import { type NextRequest } from "next/server";
import { db } from "../../../../lib/db";
import { apiError, apiOk, readJsonBody, readPagination, withApiAuth } from "../../../../lib/api-router";
import { generateSourceToken } from "../../../../lib/source-tokens";
import { prefixedId } from "../../../../lib/ids";
import { writeAudit } from "../../../../lib/audit";

export async function GET(req: NextRequest) {
  return withApiAuth(req, "read", async (ctx) => {
    // AXE-audit-Sev2 — bounded + keyset paginated. `cursor` is
    // the smallest `id` from the previous page (sources.id has a
    // descending order via created_at, but uses string `src_…`
    // ids so keyset on id is stable and unique).
    const { limit, cursor } = readPagination(req);
    const result = await db().query<{
      id: string;
      name: string | null;
      status: string;
      created_at: string;
    }>(
      cursor
        ? `SELECT id, name, status, created_at::text
             FROM sources
            WHERE workspace_id = $1 AND id < $2
            ORDER BY id DESC
            LIMIT $3`
        : `SELECT id, name, status, created_at::text
             FROM sources
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

export async function POST(req: NextRequest) {
  return withApiAuth(req, "write", async (ctx) => {
    const parsed = await readJsonBody<{ name?: string }>(req);
    if (!parsed.ok) return parsed.response;
    const name = parsed.body.name?.trim();
    if (!name || name.length < 2 || name.length > 64) {
      return apiError({ error: "name must be 2–64 characters.", code: "invalid_name" }, 400);
    }
    const sourceId = prefixedId("src");
    const token = generateSourceToken();
    const dup = await db().query(
      `SELECT 1 FROM sources WHERE workspace_id = $1 AND lower(name) = lower($2) LIMIT 1`,
      [ctx.workspace_id, name],
    );
    if ((dup.rowCount ?? 0) > 0) {
      return apiError({ error: "Source name already in use.", code: "source_name_taken" }, 409);
    }
    await db().query(
      `INSERT INTO sources (id, workspace_id, name, secret_token_hash, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [sourceId, ctx.workspace_id, name, token.hash],
    );
    await writeAudit(db(), {
      workspaceId: ctx.workspace_id,
      actorUserId: null,
      action: "api.source.created",
      targetType: "source",
      targetId: sourceId,
      metadata: { api_key_id: ctx.key_id },
    });
    return apiOk(
      {
        id: sourceId,
        name,
        secret_token: token.plaintext,
        ingest_url: `${process.env.NEXT_PUBLIC_AXEL_INGEST_URL ?? "https://ingest.axelapp.ai"}/in/${sourceId}`,
        warning: "secret_token is shown ONCE. Store it now — it cannot be retrieved later.",
      },
      201,
    );
  });
}
