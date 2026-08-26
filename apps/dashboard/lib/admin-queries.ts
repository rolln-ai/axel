import "server-only";
import { db } from "./db";

/**
 * Cross-workspace queries for the super-admin section. Deliberately kept in
 * its own file (separate from repositories.ts) so that any UNSCOPED SELECT
 * — one without a `workspace_id = $1` predicate — is grep-obvious and
 * intentional. Every function here is only callable from routes that have
 * already passed through `requireSuperAdmin()`.
 */

export interface AdminWorkspaceRow {
  id: string;
  name: string;
  slug: string | null;
  status: "active" | "suspended" | "deleted" | "deleting";
  suspended_at: string | null;
  suspension_reason: string | null;
  created_at: string;
  owner_email: string | null;
  member_count: number;
  source_count: number;
  destination_count: number;
  billing_exempt: boolean;
}

export async function listAllWorkspaces(limit = 100, offset = 0): Promise<AdminWorkspaceRow[]> {
  const result = await db().query<{
    id: string;
    name: string;
    slug: string | null;
    status: "active" | "suspended" | "deleted" | "deleting";
    suspended_at: string | null;
    suspension_reason: string | null;
    created_at: string;
    owner_email: string | null;
    member_count: string;
    source_count: string;
    destination_count: string;
    billing_exempt: boolean;
  }>(
    `SELECT w.id,
            w.name,
            w.slug,
            COALESCE(w.status, 'active') AS status,
            COALESCE(w.billing_exempt, false) AS billing_exempt,
            w.suspended_at::text AS suspended_at,
            w.suspension_reason,
            w.created_at::text AS created_at,
            owner.email AS owner_email,
            COALESCE(mc.member_count, 0)::text AS member_count,
            COALESCE(sc.source_count, 0)::text AS source_count,
            COALESCE(dc.destination_count, 0)::text AS destination_count
       FROM workspaces w
       LEFT JOIN LATERAL (
         SELECT u.email
           FROM workspace_members wm
           JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = w.id AND wm.role = 'owner'
          ORDER BY wm.created_at ASC
          LIMIT 1
       ) owner ON true
       LEFT JOIN (
         SELECT workspace_id, count(*) AS member_count
           FROM workspace_members
          GROUP BY workspace_id
       ) mc ON mc.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id, count(*) AS source_count
           FROM sources
          GROUP BY workspace_id
       ) sc ON sc.workspace_id = w.id
       LEFT JOIN (
         SELECT workspace_id, count(*) AS destination_count
           FROM destinations
          GROUP BY workspace_id
       ) dc ON dc.workspace_id = w.id
      ORDER BY w.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    status: r.status,
    suspended_at: r.suspended_at,
    suspension_reason: r.suspension_reason,
    created_at: r.created_at,
    owner_email: r.owner_email,
    member_count: Number(r.member_count),
    source_count: Number(r.source_count),
    destination_count: Number(r.destination_count),
    billing_exempt: r.billing_exempt,
  }));
}

export interface AdminWorkspaceDetail {
  id: string;
  name: string;
  slug: string | null;
  status: "active" | "suspended" | "deleted" | "deleting";
  suspended_at: string | null;
  suspended_by_user_id: string | null;
  suspension_reason: string | null;
  created_at: string;
  plan: "free" | "pro" | "enterprise";
  billing_status: "ok" | "past_due" | "grace" | "suspended" | "canceled";
  billing_exempt: boolean;
  members: Array<{
    user_id: string;
    email: string;
    name: string;
    role: "owner" | "admin" | "member";
    created_at: string;
  }>;
}

export async function getWorkspaceDetail(workspaceId: string): Promise<AdminWorkspaceDetail | null> {
  const wsResult = await db().query<{
    id: string;
    name: string;
    slug: string | null;
    status: "active" | "suspended" | "deleted" | "deleting";
    suspended_at: string | null;
    suspended_by_user_id: string | null;
    suspension_reason: string | null;
    created_at: string;
    plan: AdminWorkspaceDetail["plan"];
    billing_status: AdminWorkspaceDetail["billing_status"];
    billing_exempt: boolean;
  }>(
    `SELECT id, name, slug,
            COALESCE(status, 'active') AS status,
            suspended_at::text AS suspended_at,
            suspended_by_user_id,
            suspension_reason,
            created_at::text AS created_at,
            COALESCE(plan, 'free') AS plan,
            COALESCE(billing_status, 'ok') AS billing_status,
            COALESCE(billing_exempt, false) AS billing_exempt
       FROM workspaces
      WHERE id = $1
      LIMIT 1`,
    [workspaceId],
  );
  const ws = wsResult.rows[0];
  if (!ws) return null;

  const membersResult = await db().query<{
    user_id: string;
    email: string;
    name: string;
    role: "owner" | "admin" | "member";
    created_at: string;
  }>(
    `SELECT wm.user_id, u.email, u.name, wm.role, wm.created_at::text AS created_at
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
      ORDER BY wm.created_at ASC`,
    [workspaceId],
  );

  return { ...ws, members: membersResult.rows };
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  is_super_admin: boolean;
  created_at: string;
  workspace_count: number;
  last_seen_at: string | null;
}

export async function listAllUsers(search: string | null = null, limit = 100): Promise<AdminUserRow[]> {
  const trimmed = search?.trim() ?? "";
  const useSearch = trimmed.length > 0;
  const result = await db().query<{
    id: string;
    email: string;
    name: string;
    is_super_admin: boolean;
    created_at: string;
    workspace_count: string;
    last_seen_at: string | null;
  }>(
    `SELECT u.id,
            u.email,
            u.name,
            u.is_super_admin,
            u.created_at::text AS created_at,
            COALESCE(wc.workspace_count, 0)::text AS workspace_count,
            ls.last_seen_at::text AS last_seen_at
       FROM users u
       LEFT JOIN (
         SELECT user_id, count(*) AS workspace_count
           FROM workspace_members
          GROUP BY user_id
       ) wc ON wc.user_id = u.id
       LEFT JOIN (
         SELECT user_id, max(last_seen_at) AS last_seen_at
           FROM user_sessions
          GROUP BY user_id
       ) ls ON ls.user_id = u.id
      WHERE ($2 = false OR lower(u.email) LIKE '%' || lower($1) || '%')
      ORDER BY u.created_at DESC
      LIMIT $3`,
    [trimmed, useSearch, limit],
  );
  return result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    is_super_admin: r.is_super_admin === true,
    created_at: r.created_at,
    workspace_count: Number(r.workspace_count),
    last_seen_at: r.last_seen_at,
  }));
}

export interface AdminUserDetail {
  id: string;
  email: string;
  name: string;
  is_super_admin: boolean;
  email_verified_at: string | null;
  created_at: string;
  active_session_count: number;
  workspaces: Array<{
    workspace_id: string;
    workspace_name: string;
    role: "owner" | "admin" | "member";
    status: "active" | "suspended" | "deleted";
  }>;
}

export async function getUserDetail(userId: string): Promise<AdminUserDetail | null> {
  const userResult = await db().query<{
    id: string;
    email: string;
    name: string;
    is_super_admin: boolean;
    email_verified_at: string | null;
    created_at: string;
  }>(
    `SELECT id, email, name, is_super_admin,
            email_verified_at::text AS email_verified_at,
            created_at::text AS created_at
       FROM users WHERE id = $1 LIMIT 1`,
    [userId],
  );
  const user = userResult.rows[0];
  if (!user) return null;

  const [workspacesResult, sessionsResult] = await Promise.all([
    db().query<{
      workspace_id: string;
      workspace_name: string;
      role: "owner" | "admin" | "member";
      status: "active" | "suspended" | "deleted";
    }>(
      `SELECT wm.workspace_id, w.name AS workspace_name, wm.role,
              COALESCE(w.status, 'active') AS status
         FROM workspace_members wm
         JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.user_id = $1
        ORDER BY wm.created_at ASC`,
      [userId],
    ),
    db().query<{ c: string }>(
      `SELECT count(*)::text AS c FROM user_sessions
        WHERE user_id = $1 AND expires_at > now()`,
      [userId],
    ),
  ]);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    is_super_admin: user.is_super_admin === true,
    email_verified_at: user.email_verified_at,
    created_at: user.created_at,
    active_session_count: Number(sessionsResult.rows[0]?.c ?? 0),
    workspaces: workspacesResult.rows,
  };
}

export interface AdminCountByType {
  type: string;
  count: number;
}

/**
 * Source kind histogram. Webhook sources live in `sources` only; pull sources
 * live in both `sources` and `pull_sources` (sharing an id), with the kind on
 * `pull_sources.type`. COALESCE picks the pull type if present, else 'webhook'.
 */
export async function getSourceKindCounts(): Promise<AdminCountByType[]> {
  const result = await db().query<{ kind: string; c: string }>(
    `SELECT COALESCE(ps.type, 'webhook') AS kind, count(*)::text AS c
       FROM sources s
       LEFT JOIN pull_sources ps ON ps.id = s.id
      GROUP BY kind
      ORDER BY c DESC`,
  );
  return result.rows.map((r) => ({ type: r.kind, count: Number(r.c) }));
}

export async function getDestinationTypeCounts(): Promise<AdminCountByType[]> {
  const result = await db().query<{ type: string; c: string }>(
    `SELECT type, count(*)::text AS c
       FROM destinations
      GROUP BY type
      ORDER BY c DESC`,
  );
  return result.rows.map((r) => ({ type: r.type, count: Number(r.c) }));
}

export interface AdminOverviewCounts {
  workspaceCount: number;
  suspendedWorkspaceCount: number;
  userCount: number;
  superAdminCount: number;
  activeSessionCount: number;
  routeCount: number;
  sourceCount: number;
  destinationCount: number;
}

export async function getOverviewCounts(): Promise<AdminOverviewCounts> {
  const result = await db().query<{
    workspaces: string;
    suspended: string;
    users: string;
    super_admins: string;
    sessions: string;
    routes: string;
    sources: string;
    destinations: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM workspaces) AS workspaces,
       (SELECT count(*)::text FROM workspaces WHERE status = 'suspended') AS suspended,
       (SELECT count(*)::text FROM users) AS users,
       (SELECT count(*)::text FROM users WHERE is_super_admin = true) AS super_admins,
       (SELECT count(*)::text FROM user_sessions WHERE expires_at > now()) AS sessions,
       (SELECT count(*)::text FROM routes) AS routes,
       (SELECT count(*)::text FROM sources) AS sources,
       (SELECT count(*)::text FROM destinations) AS destinations`,
  );
  const row = result.rows[0];
  return {
    workspaceCount: Number(row?.workspaces ?? 0),
    suspendedWorkspaceCount: Number(row?.suspended ?? 0),
    userCount: Number(row?.users ?? 0),
    superAdminCount: Number(row?.super_admins ?? 0),
    activeSessionCount: Number(row?.sessions ?? 0),
    routeCount: Number(row?.routes ?? 0),
    sourceCount: Number(row?.sources ?? 0),
    destinationCount: Number(row?.destinations ?? 0),
  };
}

export interface AdminAuditRow {
  id: string;
  workspace_id: string | null;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export async function listAdminAudit(limit = 100): Promise<AdminAuditRow[]> {
  const result = await db().query<{
    id: string;
    workspace_id: string | null;
    actor_user_id: string | null;
    actor_email: string | null;
    action: string;
    target_type: string;
    target_id: string | null;
    metadata: Record<string, unknown>;
    created_at: string;
  }>(
    `SELECT al.id::text,
            al.workspace_id,
            al.actor_user_id,
            u.email AS actor_email,
            al.action,
            al.target_type,
            al.target_id,
            al.metadata,
            al.created_at::text AS created_at
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.actor_user_id
      WHERE al.action LIKE 'admin.%'
      ORDER BY al.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}
