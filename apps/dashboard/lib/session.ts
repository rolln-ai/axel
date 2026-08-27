import "server-only";
import { cache } from "react";
import { createHash, randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "./db";
import { prefixedId } from "./ids";
import { RETURN_TO_HEADER, loginPathWithReturnTo } from "./return-to";
import { DEFAULT_WORKSPACE_TIMEZONE, normalizeWorkspaceTimezone } from "./timezones";

export const SESSION_COOKIE = "axel_session";
const ACTIVE_WORKSPACE_COOKIE = "axel_active_workspace";
const SESSION_DAYS = 30;
/**
 * Skip the `UPDATE user_sessions SET last_seen_at = now()` write if the
 * session was already touched within this many seconds. The exact value of
 * `last_seen_at` only matters for "active sessions" UX and idle-timeout
 * detection — neither needs sub-minute precision. Skipping in the common
 * case removes one round-trip from every authenticated page load.
 */
const LAST_SEEN_DEBOUNCE_SECONDS = 60;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  /** When the user proved mailbox ownership; null drives the "verify your email" banner. */
  emailVerifiedAt: string | null;
}

export type WorkspaceStatus = "active" | "suspended" | "deleted";

export interface WorkspaceMembership {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string | null;
  workspace_timezone: string;
  workspace_status: WorkspaceStatus;
  role: "owner" | "admin" | "member";
}

export interface ImpersonatorInfo {
  id: string;
  email: string;
}

export interface CurrentSession {
  user: SessionUser;
  memberships: WorkspaceMembership[];
  activeWorkspace: WorkspaceMembership;
  impersonator: ImpersonatorInfo | null;
}

export interface AuthenticatedUser {
  user: SessionUser;
  impersonator: ImpersonatorInfo | null;
  /** Per-user administrator MFA enrollment. Null for ordinary users and unenrolled admins. */
  adminMfaEnabledAt: string | null;
  /** Last successful MFA step-up for this specific session. */
  adminMfaVerifiedAt: string | null;
}

export class WorkspaceSuspendedError extends Error {
  constructor(public readonly workspaceId: string) {
    super("workspace_suspended");
    this.name = "WorkspaceSuspendedError";
  }
}

export function assertWorkspaceWritable(membership: WorkspaceMembership): void {
  if (membership.workspace_status !== "active") {
    throw new WorkspaceSuspendedError(membership.workspace_id);
  }
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function createSession(userId: string): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await db().query(
    `INSERT INTO user_sessions (id, user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [prefixedId("sess"), userId, hashToken(token), expiresAt.toISOString()],
  );
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db().query("DELETE FROM user_sessions WHERE session_token_hash = $1", [hashToken(token)]);
  }
  jar.delete(SESSION_COOKIE);
}

interface SessionJoinRow {
  session_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  user_is_super_admin: boolean;
  user_email_verified_at: string | null;
  last_seen_at: string | null;
  impersonator_user_id: string | null;
  impersonator_email: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  workspace_slug: string | null;
  workspace_timezone: string | null;
  workspace_status: WorkspaceStatus | null;
  role: "owner" | "admin" | "member" | null;
  workspace_created_at: string | null;
}

/**
 * Read the current session and the user's workspace memberships in a SINGLE
 * Postgres round-trip. Previously this fired three serial queries (session
 * → last_seen update → memberships) which cost 3× round-trip latency on
 * every authenticated page load.
 *
 * Wrapped in React's `cache()` so multiple `requireSession()` calls within
 * the same request (e.g. layout AND page) share the result without a re-fetch.
 */
export const getCurrentSession = cache(async (): Promise<CurrentSession | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const activeWorkspaceId = jar.get(ACTIVE_WORKSPACE_COOKIE)?.value;

  const rows = await db().query<SessionJoinRow>(
    `SELECT s.id AS session_id,
            u.id AS user_id, u.email AS user_email, u.name AS user_name,
            u.is_super_admin AS user_is_super_admin,
            u.email_verified_at::text AS user_email_verified_at,
            s.last_seen_at::text AS last_seen_at,
            s.impersonator_user_id,
            imp.email AS impersonator_email,
            w.id AS workspace_id, w.name AS workspace_name, w.slug AS workspace_slug,
            COALESCE(w.timezone, $2) AS workspace_timezone,
            COALESCE(w.status, 'active') AS workspace_status,
            wm.role,
            wm.created_at::text AS workspace_created_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users imp ON imp.id = s.impersonator_user_id
       LEFT JOIN workspace_members wm ON wm.user_id = u.id
       -- Workspaces pending async teardown are hidden from the switcher: the
       -- join misses, so the membership is dropped and the user can't land on a
       -- workspace that's mid-deletion.
       LEFT JOIN workspaces w ON w.id = wm.workspace_id AND COALESCE(w.status, 'active') <> 'deleting'
      WHERE s.session_token_hash = $1
        AND s.expires_at > now()
      ORDER BY wm.created_at ASC NULLS LAST`,
    [hashToken(token), DEFAULT_WORKSPACE_TIMEZONE],
  );

  const first = rows.rows[0];
  if (!first) return null;

  const memberships: WorkspaceMembership[] = rows.rows
    .filter((r): r is SessionJoinRow & { workspace_id: string; workspace_name: string; role: NonNullable<SessionJoinRow["role"]> } =>
      r.workspace_id !== null && r.workspace_name !== null && r.role !== null,
    )
    .map((r) => ({
      workspace_id: r.workspace_id,
      workspace_name: r.workspace_name,
      workspace_slug: r.workspace_slug,
      workspace_timezone: normalizeWorkspaceTimezone(r.workspace_timezone),
      workspace_status: (r.workspace_status ?? "active") as WorkspaceStatus,
      role: r.role,
    }));

  const activeWorkspace =
    memberships.find((membership) => membership.workspace_id === activeWorkspaceId) ?? memberships[0];
  if (!activeWorkspace) return null;

  const impersonator: ImpersonatorInfo | null =
    first.impersonator_user_id && first.impersonator_email
      ? { id: first.impersonator_user_id, email: first.impersonator_email }
      : null;

  // Debounced fire-and-forget last_seen_at update. The page response no
  // longer waits on this round-trip; if it fails we just keep the slightly-
  // stale timestamp and try again on the next render.
  const lastSeenStale =
    first.last_seen_at === null ||
    Date.now() - Date.parse(first.last_seen_at) > LAST_SEEN_DEBOUNCE_SECONDS * 1000;
  if (lastSeenStale) {
    void db()
      .query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [first.session_id])
      .catch((err) => {
        // Best-effort. Log to stderr so Vercel/Render captures it but never
        // surface to the user.
        console.error("[session] last_seen_at update failed:", err);
      });
  }

  return {
    user: {
      id: first.user_id,
      email: first.user_email,
      name: first.user_name,
      isSuperAdmin: first.user_is_super_admin === true,
      emailVerifiedAt: first.user_email_verified_at,
    },
    memberships,
    activeWorkspace,
    impersonator,
  };
});

/**
 * Where to bounce an unauthenticated request. The proxy stamps the requested
 * path into RETURN_TO_HEADER (always overwritten, never client-controlled);
 * loginPathWithReturnTo re-validates it to a same-origin relative path so the
 * user lands back where they were after signIn instead of on /dashboard.
 */
async function loginRedirectPath(): Promise<string> {
  const h = await headers();
  return loginPathWithReturnTo(h.get(RETURN_TO_HEADER));
}

export async function requireSession(): Promise<CurrentSession> {
  const session = await getCurrentSession();
  if (!session) redirect(await loginRedirectPath());
  return session;
}

/**
 * Authenticated-user gate WITHOUT requiring workspace membership. Used by the
 * super-admin route group: a super-admin may not belong to any workspace yet
 * still need to manage other accounts. Returns the user identity and the
 * impersonator (if the session is currently impersonating someone).
 */
export const getAuthenticatedUser = cache(async (): Promise<AuthenticatedUser | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db().query<{
    user_id: string;
    user_email: string;
    user_name: string;
    user_is_super_admin: boolean;
    user_email_verified_at: string | null;
    impersonator_user_id: string | null;
    impersonator_email: string | null;
    admin_mfa_enabled_at: string | null;
    admin_mfa_verified_at: string | null;
  }>(
    `SELECT u.id AS user_id, u.email AS user_email, u.name AS user_name,
            u.is_super_admin AS user_is_super_admin,
            u.email_verified_at::text AS user_email_verified_at,
            s.impersonator_user_id,
            imp.email AS impersonator_email,
            m.enabled_at::text AS admin_mfa_enabled_at,
            s.admin_mfa_verified_at::text AS admin_mfa_verified_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN users imp ON imp.id = s.impersonator_user_id
       LEFT JOIN admin_mfa_methods m ON m.user_id = u.id
      WHERE s.session_token_hash = $1
        AND s.expires_at > now()
      LIMIT 1`,
    [hashToken(token)],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    user: {
      id: row.user_id,
      email: row.user_email,
      name: row.user_name,
      isSuperAdmin: row.user_is_super_admin === true,
      emailVerifiedAt: row.user_email_verified_at,
    },
    impersonator:
      row.impersonator_user_id && row.impersonator_email
        ? { id: row.impersonator_user_id, email: row.impersonator_email }
        : null,
    adminMfaEnabledAt: row.admin_mfa_enabled_at,
    adminMfaVerifiedAt: row.admin_mfa_verified_at,
  };
});

export async function requireAuthenticatedUser(): Promise<AuthenticatedUser> {
  const auth = await getAuthenticatedUser();
  if (!auth) redirect(await loginRedirectPath());
  return auth;
}

export async function setActiveWorkspaceId(workspaceId: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}
