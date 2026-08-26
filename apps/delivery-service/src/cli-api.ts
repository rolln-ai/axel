/**
 * `/v1/cli/*` HTTP surface used by `@axel/cli` (AXE-26).
 *
 * Auth: `Authorization: Bearer <PAT>` — the PAT is hashed and looked
 * up in `personal_access_tokens`. Every successful request bumps
 * `last_used_at` so operators can spot stale tokens.
 *
 * Routes:
 *   GET  /v1/cli/me                            — auth ping; returns
 *                                                user/workspace/token info.
 *   POST /v1/cli/trigger                       — fan-out a test event
 *                                                through the ingest path
 *                                                (proxies the ingest-worker
 *                                                admin/trigger-event endpoint).
 *   GET  /v1/cli/events/:event_id/payload      — pull the original raw
 *                                                bytes Axel persisted to R2
 *                                                so `axel replay` can re-fire
 *                                                them at a localhost handler.
 */

import http from "node:http";
import { createHash } from "node:crypto";
import type pg from "pg";
import { captureException } from "@axel/observability";
import { handleListenStream } from "./cli-events-stream.js";

// Loosely typed sentry client — observability exposes a SentryClient
// that may be `null` in dev when SENTRY_DSN is unset, so accept the
// nullable shape rather than re-import the strict type.
type SentryClient = Parameters<typeof captureException>[0];

interface CliAuthCtx {
  user_id: string;
  user_email: string;
  workspace_id: string;
  workspace_name: string;
  token_id: string;
  token_name: string;
  token_created_at: string;
}

const TOKEN_PREFIX = "axe_pat_";
// Token format: `axe_pat_<48-char base32>`. Hashed with sha256-hex
// before lookup so a leaked DB doesn't yield usable tokens.
function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

async function authenticate(
  req: http.IncomingMessage,
  pool: pg.Pool,
): Promise<CliAuthCtx | { error: { status: number; code: string; message: string } }> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return { error: { status: 401, code: "missing_token", message: "Authorization: Bearer <pat> required." } };
  }
  const presented = header.slice("Bearer ".length).trim();
  if (!presented.startsWith(TOKEN_PREFIX)) {
    return { error: { status: 401, code: "invalid_token", message: "Token does not look like an Axel PAT." } };
  }
  const tokenHash = hashToken(presented);
  const result = await pool.query<{
    pat_id: string;
    pat_name: string;
    pat_created_at: string;
    pat_expires_at: string | null;
    pat_revoked_at: string | null;
    user_id: string;
    user_email: string;
    workspace_id: string;
    workspace_name: string;
  }>(
    `SELECT pat.id AS pat_id, pat.name AS pat_name,
            pat.created_at::text AS pat_created_at,
            pat.expires_at::text AS pat_expires_at,
            pat.revoked_at::text AS pat_revoked_at,
            u.id AS user_id, u.email AS user_email,
            w.id AS workspace_id, w.name AS workspace_name
       FROM personal_access_tokens pat
       JOIN users u ON u.id = pat.user_id
       JOIN workspaces w ON w.id = pat.workspace_id
      WHERE pat.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) {
    return { error: { status: 401, code: "invalid_token", message: "Token not recognised." } };
  }
  if (row.pat_revoked_at) {
    return { error: { status: 401, code: "revoked_token", message: "Token has been revoked." } };
  }
  if (row.pat_expires_at && new Date(row.pat_expires_at).getTime() < Date.now()) {
    return { error: { status: 401, code: "expired_token", message: "Token has expired." } };
  }
  // Fire-and-forget — don't block the request on the bookkeeping.
  pool
    .query("UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1", [row.pat_id])
    .catch((err: unknown) => {
      console.error("[cli-api] failed to update last_used_at:", err);
    });
  return {
    user_id: row.user_id,
    user_email: row.user_email,
    workspace_id: row.workspace_id,
    workspace_name: row.workspace_name,
    token_id: row.pat_id,
    token_name: row.pat_name,
    token_created_at: row.pat_created_at,
  };
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {} as T;
  return JSON.parse(raw) as T;
}

export interface CliApiDeps {
  pool: pg.Pool;
  sentry: SentryClient;
  /** Base URL of the ingest worker (https://ingest.axelapp.ai). */
  ingestBaseUrl: string;
  /** Shared admin token honoured by ingest-worker's /admin/* surface. */
  ingestAdminToken: string;
  /** Cloudflare account credentials for R2 raw-payload reads. */
  cloudflareAccountId: string;
  cloudflareApiToken: string;
  /** R2 bucket where ingest-worker stores raw payloads. */
  rawPayloadBucket: string;
  /** ClickHouse Cloud HTTPS endpoint + credentials for events lookup. */
  clickhouseUrl: string | undefined;
  clickhouseUser: string | undefined;
  clickhousePassword: string | undefined;
}

/**
 * Returns true if the request was handled, false to fall through to
 * the next route check in server.ts.
 */
export async function handleCliApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: CliApiDeps,
): Promise<boolean> {
  const rawUrl = req.url ?? "";
  if (!rawUrl.startsWith("/v1/cli/")) return false;
  // Parse query string off so route matching against the path works
  // even when the listen endpoint sends `?source_id=…&since=…`.
  const parsedUrl = new URL(rawUrl, "http://internal");
  const path = parsedUrl.pathname;

  // Every /v1/cli/* route requires authentication.
  const authResult = await authenticate(req, deps.pool);
  if ("error" in authResult) {
    jsonResponse(res, authResult.error.status, {
      error: authResult.error.code,
      message: authResult.error.message,
    });
    return true;
  }
  const ctx = authResult;

  if (req.method === "GET" && path === "/v1/cli/me") {
    jsonResponse(res, 200, {
      user: { id: ctx.user_id, email: ctx.user_email },
      workspace: { id: ctx.workspace_id, name: ctx.workspace_name },
      token: { id: ctx.token_id, name: ctx.token_name, created_at: ctx.token_created_at },
    });
    return true;
  }

  if (req.method === "POST" && path === "/v1/cli/trigger") {
    await handleTrigger(req, res, ctx, deps);
    return true;
  }

  // AXE-26 Phase 2 — `axel listen` polls this endpoint once a second.
  if (req.method === "GET" && path === "/v1/cli/events") {
    await handleListenStream(res, { workspace_id: ctx.workspace_id }, deps, parsedUrl);
    return true;
  }

  const eventPayloadMatch = path.match(/^\/v1\/cli\/events\/([^/]+)\/payload$/);
  if (req.method === "GET" && eventPayloadMatch) {
    const eventId = decodeURIComponent(eventPayloadMatch[1]!);
    await handleEventPayload(req, res, ctx, deps, eventId);
    return true;
  }

  jsonResponse(res, 404, { error: "not_found", message: `Unknown CLI route: ${path}` });
  return true;
}

interface TriggerRequest {
  source_id?: string;
  provider?: string;
  event_type?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function handleTrigger(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: CliAuthCtx,
  deps: CliApiDeps,
): Promise<void> {
  let body: TriggerRequest;
  try {
    body = await readJsonBody<TriggerRequest>(req);
  } catch (_err: unknown) {
    jsonResponse(res, 400, {
      error: "invalid_json",
      message: "Request body is not valid JSON.",
    });
    return;
  }
  if (!body.source_id || typeof body.source_id !== "string") {
    jsonResponse(res, 400, { error: "missing_source_id", message: "Body must include source_id." });
    return;
  }
  // Confirm the source belongs to the caller's workspace before
  // forwarding. Otherwise a PAT for one workspace could trigger
  // events into another workspace's source by guessing source_id.
  const sourceCheck = await deps.pool.query<{ id: string }>(
    "SELECT id FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1",
    [body.source_id, ctx.workspace_id],
  );
  if (!sourceCheck.rowCount) {
    jsonResponse(res, 404, {
      error: "source_not_found",
      message: `Source ${body.source_id} is not in workspace ${ctx.workspace_id}.`,
    });
    return;
  }

  // Forward to the ingest-worker admin/trigger-event surface. The
  // ingest worker is the canonical owner of the "write to R2 + enqueue
  // shard" sequence; reproducing that in delivery-service would
  // double-maintain the same logic. Admin token auth is already wired.
  const ingestUrl = `${deps.ingestBaseUrl.replace(/\/$/, "")}/admin/trigger-event`;
  const adminBody = {
    source_id: body.source_id,
    headers: body.headers ?? { "content-type": "application/json" },
    content_type: body.headers?.["content-type"] ?? "application/json",
    body: body.body ?? {},
    is_test: true,
    actor_kind: "cli" as const,
  };
  let ingestRes: Response;
  try {
    ingestRes = await fetch(ingestUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-axel-admin-token": deps.ingestAdminToken,
      },
      body: JSON.stringify(adminBody),
    });
  } catch (err: unknown) {
    void captureException(deps.sentry, err, {
      tags: {
        component: "cli_trigger",
        workspace_id: ctx.workspace_id,
        source_id: body.source_id,
      },
    });
    jsonResponse(res, 502, {
      error: "ingest_unreachable",
      message: "Ingest service request failed.",
    });
    return;
  }
  const ingestText = await ingestRes.text().catch(() => "");
  if (!ingestRes.ok) {
    jsonResponse(res, 502, {
      error: `ingest_${ingestRes.status}`,
      message: ingestText.slice(0, 200),
    });
    return;
  }
  let parsed: { event_id?: string; received_at?: string };
  try {
    parsed = JSON.parse(ingestText) as typeof parsed;
  } catch {
    parsed = {};
  }
  jsonResponse(res, 200, {
    event_id: parsed.event_id,
    received_at: parsed.received_at,
    source_id: body.source_id,
  });
}

async function handleEventPayload(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: CliAuthCtx,
  deps: CliApiDeps,
  eventId: string,
): Promise<void> {
  if (!deps.clickhouseUrl) {
    jsonResponse(res, 503, {
      error: "clickhouse_unconfigured",
      message: "delivery-service has no CLICKHOUSE_URL — can't resolve event metadata.",
    });
    return;
  }
  // Resolve event_id → r2_key + headers + content_type via ClickHouse.
  // Same query the dashboard's getEventDetail uses; scoped to the
  // caller's workspace.
  const chHeaders: Record<string, string> = { accept: "application/json" };
  if (deps.clickhouseUser) chHeaders["x-clickhouse-user"] = deps.clickhouseUser;
  if (deps.clickhousePassword) chHeaders["x-clickhouse-key"] = deps.clickhousePassword;
  const query = `SELECT event_id, source_id, toString(received_at) AS received_at,
                         content_type, r2_key, headers_json
                    FROM events
                   WHERE workspace_id = {workspace_id:String}
                     AND event_id     = {event_id:String}
                   LIMIT 1
                   FORMAT JSON`;
  const chUrl = new URL(deps.clickhouseUrl);
  chUrl.searchParams.set("query", query);
  chUrl.searchParams.set("param_workspace_id", ctx.workspace_id);
  chUrl.searchParams.set("param_event_id", eventId);
  let chRes: Response;
  try {
    chRes = await fetch(chUrl, { headers: chHeaders });
  } catch (err: unknown) {
    void captureException(deps.sentry, err, {
      tags: { component: "cli_event_payload", workspace_id: ctx.workspace_id },
    });
    jsonResponse(res, 502, {
      error: "clickhouse_unreachable",
      message: "ClickHouse request failed.",
    });
    return;
  }
  if (!chRes.ok) {
    const body = await chRes.text().catch(() => "");
    jsonResponse(res, 502, {
      error: `clickhouse_${chRes.status}`,
      message: body.slice(0, 200),
    });
    return;
  }
  const chJson = (await chRes.json()) as {
    data?: Array<{
      event_id: string;
      source_id: string;
      received_at: string;
      content_type: string;
      r2_key: string;
      headers_json: string;
    }>;
  };
  const event = chJson.data?.[0];
  if (!event) {
    jsonResponse(res, 404, {
      error: "event_not_found",
      message: `No event ${eventId} in workspace ${ctx.workspace_id} (or outside the 30d ClickHouse TTL).`,
    });
    return;
  }

  // Pull raw bytes from R2 via the Cloudflare account-scoped HTTP API
  // (delivery-service has no Wrangler binding because it lives on
  // Render). Same URL shape the dashboard uses.
  const r2Url = `https://api.cloudflare.com/client/v4/accounts/${deps.cloudflareAccountId}/r2/buckets/${deps.rawPayloadBucket}/objects/${encodeURIComponent(event.r2_key)}`;
  const r2Res = await fetch(r2Url, {
    headers: { authorization: `Bearer ${deps.cloudflareApiToken}` },
  });
  if (!r2Res.ok) {
    jsonResponse(res, 502, {
      error: `r2_${r2Res.status}`,
      message: await r2Res.text().then((t) => t.slice(0, 200)).catch(() => ""),
    });
    return;
  }
  const buf = Buffer.from(await r2Res.arrayBuffer());
  let headers: Record<string, string> = {};
  try {
    headers = JSON.parse(event.headers_json) as Record<string, string>;
  } catch {
    headers = {};
  }

  jsonResponse(res, 200, {
    event_id: event.event_id,
    source_id: event.source_id,
    received_at: event.received_at,
    content_type: event.content_type,
    body_base64: buf.toString("base64"),
    headers,
  });
}
