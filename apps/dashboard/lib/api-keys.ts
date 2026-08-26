import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { db } from "./db";

/**
 * AXE-29 — workspace API key management.
 *
 * Plaintext format: `axl_<24 random base32 chars>`. The first 12
 * chars (including `axl_`) become `key_prefix` so the dashboard
 * can label the row (e.g. `axl_abc123…`); the rest never leaves
 * memory once the SHA-256 hash is computed.
 */

export type ApiScope = "read" | "write" | "replay" | "admin";

const ALL_SCOPES: readonly ApiScope[] = ["read", "write", "replay", "admin"];
const SCOPE_IMPLIES: Record<ApiScope, ApiScope[]> = {
  read: ["read"],
  write: ["read", "write"],
  replay: ["read", "replay"],
  admin: ["read", "write", "replay", "admin"],
};

export interface ApiKeyRow {
  id: string;
  workspace_id: string;
  name: string;
  key_prefix: string;
  scopes: ApiScope[];
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface ApiKeyAuthContext {
  workspace_id: string;
  scopes: ApiScope[];
  key_id: string;
}

/**
 * Mint a new key. Returns plaintext + the persisted row metadata.
 * Caller is responsible for showing plaintext exactly once.
 */
export async function createApiKey(input: {
  workspaceId: string;
  createdByUserId: string;
  name: string;
  scopes: ApiScope[];
}): Promise<{ plaintext: string; row: ApiKeyRow }> {
  if (input.scopes.length === 0) throw new Error("at least one scope is required");
  const invalid = input.scopes.filter((s) => !ALL_SCOPES.includes(s));
  if (invalid.length > 0) throw new Error(`invalid scopes: ${invalid.join(",")}`);
  // 24-char base32-ish randomness → 120 bits of entropy.
  const random = randomBytes(15).toString("base64url").slice(0, 24);
  const plaintext = `axl_${random}`;
  const hash = sha256Hex(plaintext);
  const prefix = plaintext.slice(0, 12);
  const id = `apik_${randomBytes(10).toString("base64url")}`;
  const result = await db().query<ApiKeyRow>(
    `INSERT INTO workspace_api_keys
       (id, workspace_id, created_by_user_id, name, key_hash, key_prefix, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, workspace_id, name, key_prefix, scopes, created_at::text, last_used_at::text, revoked_at::text`,
    [id, input.workspaceId, input.createdByUserId, input.name, hash, prefix, input.scopes],
  );
  const row = result.rows[0];
  if (!row) throw new Error("api key insert returned no row");
  return { plaintext, row };
}

export async function listApiKeys(workspaceId: string): Promise<ApiKeyRow[]> {
  const result = await db().query<ApiKeyRow>(
    `SELECT id, workspace_id, name, key_prefix, scopes,
            created_at::text, last_used_at::text, revoked_at::text
       FROM workspace_api_keys
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return result.rows;
}

export async function revokeApiKey(workspaceId: string, keyId: string): Promise<boolean> {
  const result = await db().query(
    `UPDATE workspace_api_keys
        SET revoked_at = now()
      WHERE id = $1 AND workspace_id = $2 AND revoked_at IS NULL`,
    [keyId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Personal Access Token prefix (see lib/pat-actions.ts TOKEN_PREFIX). PATs
 * power the Axel CLI and authenticate against the same /api/v1/* surface as
 * workspace keys, so authenticateApiKey accepts both.
 */
const PAT_PREFIX = "axe_pat_";

/**
 * Scopes granted to an authenticated PAT. A PAT acts on behalf of a user in a
 * workspace, so it gets the operational scopes (read/write/replay) but NOT
 * `admin` — minting/revoking workspace keys is a dashboard-only action and a
 * leaked CLI token must not be able to escalate to key management.
 */
const PAT_SCOPES: ApiScope[] = ["read", "write", "replay"];

/**
 * Authenticate a Next.js Request via `Authorization: Bearer axl_…` (workspace
 * key) or `Bearer axe_pat_…` (personal access token — the CLI credential).
 * Returns null on any failure (wrong scheme, unknown/revoked/expired token,
 * non-active workspace). Updates `last_used_at` best-effort (fire-and-forget)
 * so the dashboard can show "last used 3min ago" without blocking the hot path.
 */
export async function authenticateApiKey(authHeader: string | null): Promise<ApiKeyAuthContext | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  // PATs (axe_pat_) validate against personal_access_tokens; workspace keys
  // (axl_) against workspace_api_keys. Anything else is rejected.
  if (token.startsWith(PAT_PREFIX)) return authenticatePat(token);
  if (!token.startsWith("axl_")) return null;
  const hash = sha256Hex(token);
  const result = await db().query<{
    id: string;
    workspace_id: string;
    scopes: ApiScope[];
    revoked_at: string | null;
    workspace_status: "active" | "suspended" | "deleted";
  }>(
    `SELECT k.id, k.workspace_id, k.scopes, k.revoked_at::text, w.status AS workspace_status
       FROM workspace_api_keys k
       JOIN workspaces w ON w.id = k.workspace_id
      WHERE k.key_hash = $1
      LIMIT 1`,
    [hash],
  );
  const row = result.rows[0];
  // Reject revoked keys AND keys for a non-active workspace. The session/server-
  // action path enforces requireActiveWorkspace on every mutation; without this
  // the API key path let a suspended/soft-deleted workspace keep full v1 write +
  // billable-replay access. (INNER JOIN also drops keys whose workspace was
  // hard-deleted.)
  if (!row || row.revoked_at || row.workspace_status !== "active") return null;
  // Fire-and-forget last_used bump.
  void db().query(
    `UPDATE workspace_api_keys SET last_used_at = now() WHERE id = $1`,
    [row.id],
  ).catch(() => {});
  return { workspace_id: row.workspace_id, scopes: row.scopes, key_id: row.id };
}

/**
 * Validate a personal access token. PATs are SHA-256-hashed the same way as
 * workspace keys (see pat-actions.ts hashToken). Rejects revoked, expired, or
 * non-active-workspace tokens; grants the operational PAT scopes. `key_id` is
 * the PAT id so audit/last-used attribution still works.
 */
async function authenticatePat(token: string): Promise<ApiKeyAuthContext | null> {
  const hash = sha256Hex(token);
  const result = await db().query<{
    id: string;
    workspace_id: string;
    revoked_at: string | null;
    expires_at: string | null;
    workspace_status: "active" | "suspended" | "deleted";
  }>(
    `SELECT p.id, p.workspace_id, p.revoked_at::text, p.expires_at::text, w.status AS workspace_status
       FROM personal_access_tokens p
       JOIN workspaces w ON w.id = p.workspace_id
      WHERE p.token_hash = $1
      LIMIT 1`,
    [hash],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || row.workspace_status !== "active") return null;
  // Reject an expired PAT (expires_at is optional; null = never expires).
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  void db().query(
    `UPDATE personal_access_tokens SET last_used_at = now() WHERE id = $1`,
    [row.id],
  ).catch(() => {});
  return { workspace_id: row.workspace_id, scopes: PAT_SCOPES, key_id: row.id };
}

export function scopeAllows(ctx: ApiKeyAuthContext, required: ApiScope): boolean {
  return ctx.scopes.some((s) => SCOPE_IMPLIES[s]?.includes(required));
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
