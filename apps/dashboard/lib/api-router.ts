import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { authenticateApiKey, scopeAllows, type ApiKeyAuthContext, type ApiScope } from "./api-keys";
import { enforceAuthRateLimits } from "./rate-limit";
import { requestIpFromHeaders } from "./request-ip";

/**
 * ROL-204 — rate limits for the public /api/v1 bearer-auth path. Postgres-backed
 * and fail-closed so a stolen or guessed token is never unthrottled.
 *   - per-IP counts only FAILED auths → blunts credential-stuffing / token
 *     brute-force without touching legitimate valid-token traffic.
 *   - per-key caps throughput of a valid token → bounds a stolen key's blast
 *     radius; generous (~10 rps sustained) so normal control-plane use never hits it.
 */
const API_RL_WINDOW_MS = 5 * 60_000;
const API_RL_IP_FAILED_MAX = 30;
const API_RL_KEY_MAX = 3_000;
export const MAX_API_JSON_BODY_BYTES = 1024 * 1024;

function clientIp(req: NextRequest): string | null {
  return requestIpFromHeaders(req.headers);
}

/**
 * AXE-29 — request-level helpers for the REST control plane.
 *
 * `withApiAuth(req, scope, handler)` is the workhorse: validates
 * `Authorization: Bearer axl_…`, checks the scope, calls the
 * handler with the authenticated context. Any failure short-
 * circuits with a JSON error envelope (`{error, code}`) so clients
 * get a single, parseable shape across every endpoint.
 */

export interface ApiErrorBody {
  error: string;
  code: string;
}

/**
 * AXE-audit-Sev2 — every /api/v1 response is workspace-scoped
 * sensitive data. `private, no-store` defeats any naive
 * intermediary cache. CF default rules already skip on
 * `Authorization` header but customer self-host with their own
 * reverse proxy may not.
 */
const DEFAULT_API_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
};

export function apiError(
  body: ApiErrorBody,
  status: number,
  extraHeaders?: Record<string, string>,
): NextResponse {
  return NextResponse.json(body, { status, headers: { ...DEFAULT_API_HEADERS, ...extraHeaders } });
}

export function apiOk<T>(body: T, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: DEFAULT_API_HEADERS });
}

/**
 * AXE-audit-Sev2 — common pagination params. `limit` is capped at
 * 1000 (matches Stripe's hard cap); `cursor` is the last id seen
 * in the previous page, used in a `WHERE id < cursor ORDER BY id
 * DESC` keyset. The endpoint is responsible for the actual SQL.
 */
export interface PaginationParams {
  limit: number;
  cursor: string | null;
}

export function readPagination(req: { url: string }, defaultLimit = 50, maxLimit = 1000): PaginationParams {
  const url = new URL(req.url);
  const rawLimit = url.searchParams.get("limit");
  let limit = defaultLimit;
  if (rawLimit) {
    const parsed = Number(rawLimit);
    if (Number.isFinite(parsed) && parsed > 0) {
      limit = Math.min(maxLimit, Math.floor(parsed));
    }
  }
  return { limit, cursor: url.searchParams.get("cursor") };
}

export async function withApiAuth(
  req: NextRequest,
  required: ApiScope,
  handler: (ctx: ApiKeyAuthContext, req: NextRequest) => Promise<NextResponse>,
): Promise<NextResponse> {
  const auth = await authenticateApiKey(req.headers.get("authorization"));
  if (!auth) {
    // Throttle repeated failed auths per source IP (credential-stuffing / token
    // brute-force). Only failures record a hit, so valid-token clients sharing an
    // IP are unaffected. Store failures fail closed for a short retry window.
    const ip = clientIp(req);
    if (ip) {
      const breach = await enforceAuthRateLimits([
        [`api:authfail:ip:${ip}`, API_RL_IP_FAILED_MAX, API_RL_WINDOW_MS],
      ]);
      if (breach) {
        return apiError(
          { error: "Too many authentication attempts. Try again later.", code: "rate_limited" },
          429,
          { "Retry-After": String(breach.retryAfterSeconds) },
        );
      }
    }
    return apiError(
      { error: "Missing or invalid Authorization header. Expected `Bearer axl_…`.", code: "unauthenticated" },
      401,
    );
  }
  // Per-key throughput cap — bounds the blast radius of a stolen valid token.
  const keyBreach = await enforceAuthRateLimits([
    [`api:key:${auth.key_id}`, API_RL_KEY_MAX, API_RL_WINDOW_MS],
  ]);
  if (keyBreach) {
    return apiError(
      { error: "API rate limit exceeded for this key.", code: "rate_limited" },
      429,
      { "Retry-After": String(keyBreach.retryAfterSeconds) },
    );
  }
  if (!scopeAllows(auth, required)) {
    return apiError(
      { error: `This endpoint requires the "${required}" scope.`, code: "forbidden_scope" },
      403,
    );
  }
  try {
    return await handler(auth, req);
  } catch {
    // Log the real error server-side, but NEVER forward err.message to the
    // caller — raw PG/driver errors leak DB hostnames/IPs + schema/index names to
    // any bearer-key holder (audit). Return a generic, fixed message.
    console.error("[api] handler failed");
    return apiError({ error: "Internal server error.", code: "internal_error" }, 500);
  }
}

/**
 * Parse a JSON body and reject with 400 if invalid. Keeps every
 * endpoint from duplicating the try/catch.
 */
export async function readJsonBody<T = unknown>(req: NextRequest): Promise<{ ok: true; body: T } | { ok: false; response: NextResponse }> {
  const declaredLength = req.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_API_JSON_BODY_BYTES) {
      return {
        ok: false,
        response: apiError(
          { error: "Request body exceeds the allowed size.", code: "request_too_large" },
          413,
        ),
      };
    }
  }

  try {
    const reader = req.body?.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let totalBytes = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > MAX_API_JSON_BODY_BYTES) {
            await reader.cancel().catch(() => undefined);
            return {
              ok: false,
              response: apiError(
                { error: "Request body exceeds the allowed size.", code: "request_too_large" },
                413,
              ),
            };
          }
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
    const body = JSON.parse(text) as T;
    return { ok: true, body };
  } catch {
    return {
      ok: false,
      response: apiError(
        { error: "Body isn't valid JSON.", code: "invalid_body" },
        400,
      ),
    };
  }
}
