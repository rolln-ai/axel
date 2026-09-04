import "server-only";
import { createHash } from "node:crypto";
import { unstable_cache, updateTag } from "next/cache";
import { sanitizeConnectorDiagnosticForStorage, type SourceProvider } from "@axel/shared";
import type { Queryable } from "./db";
import { db } from "./db";

/**
 * Per-workspace tag families used by `unstable_cache` wrappers below and
 * `updateTag()` calls in server actions. Centralising the helpers keeps
 * cached readers and mutating writers from drifting out of sync — a stale
 * tag string means stale data on the dashboard.
 */
export function workspaceCacheScope(workspaceId: string): string {
  return createHash("sha256")
    .update("axel-dashboard-cache\0")
    .update(workspaceId)
    .digest("hex")
    .slice(0, 24);
}

export const cacheTags = {
  metrics: (ws: string) => `ws-${workspaceCacheScope(ws)}-metrics`,
  sources: (ws: string) => `ws-${workspaceCacheScope(ws)}-sources`,
  deadLetters: (ws: string) => `ws-${workspaceCacheScope(ws)}-dead-letters`,
  replays: (ws: string) => `ws-${workspaceCacheScope(ws)}-replays`,
  replayJobs: (ws: string) => `ws-${workspaceCacheScope(ws)}-replay-jobs`,
  routes: (ws: string) => `ws-${workspaceCacheScope(ws)}-routes`,
  destinations: (ws: string) => `ws-${workspaceCacheScope(ws)}-destinations`,
};

/**
 * Bust every per-workspace `unstable_cache` tag family after a mutation
 * whose blast radius spans multiple surfaces (workspace rename/settings,
 * data wipes, admin suspend/unsuspend, first-run pipeline creation).
 * Actions with a narrow footprint should keep busting individual
 * `cacheTags.*` entries instead.
 *
 * Must be called from a server action or route handler (updateTag
 * constraint). Replaces two identical private copies that used to live in
 * actions.ts (refreshWorkspaceDataTags) and admin-actions.ts
 * (bustWorkspaceCacheTags).
 */
export function bustWorkspaceTags(workspaceId: string): void {
  updateTag(cacheTags.metrics(workspaceId));
  updateTag(cacheTags.sources(workspaceId));
  updateTag(cacheTags.routes(workspaceId));
  updateTag(cacheTags.destinations(workspaceId));
  updateTag(cacheTags.deadLetters(workspaceId));
  updateTag(cacheTags.replays(workspaceId));
}

const DASHBOARD_REVALIDATE_SECONDS = 60;

export interface DashboardMetric {
  label: string;
  value: string;
}

export interface SourceRow {
  id: string;
  name: string;
  status: string;
  /**
   * "webhook" plus every pull-source connector type the DB can contain.
   * Pull-source CREATION is retired (webhook-only is intentional), but legacy
   * rows with postgres/mongodb/bigquery kinds still exist and keep syncing —
   * the previous narrower union was simply wrong for that data.
   */
  source_kind: "webhook" | "chargebee" | "stripe" | "shopify" | "postgres" | "mongodb" | "bigquery";
  provider: SourceProvider;
  max_events_per_minute: number | null;
  created_at: string;
}

export interface DeliveryRow {
  id: string;
  event_id: string;
  route_id: string;
  reason: string;
  errored_at: string;
}

export interface TeamMemberRow {
  user_id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  created_at: string;
}

export interface InviteRow {
  id: string;
  email: string;
  role: "admin" | "member";
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface DeadLetterFullRow {
  id: string;
  event_id: string;
  source_id: string;
  route_id: string;
  r2_key: string;
  reason: string;
  message: string;
  errored_at: string;
  replay_id: string | null;
  replay_state: ReplayRequestRow["state"] | null;
  replay_requested_at: string | null;
  replay_finished_at: string | null;
  replay_error_message: string | null;
}

export interface ReplayRequestRow {
  id: string;
  event_id: string;
  source_id: string;
  scope: "route" | "destination" | "all";
  route_id: string | null;
  destination_id: string | null;
  state: "pending" | "in_progress" | "done" | "failed";
  reason: string | null;
  requested_at: string;
  finished_at: string | null;
  error_message: string | null;
}

/**
 * SQL fragment for unresolved dead_letters. Successful replay delivery writes
 * `resolved_at` on the dead-letter row; the row stays for audit, but it no
 * longer appears in operator backlogs.
 *
 * Requires the host query to alias the dead_letters table as `dl`.
 */
const DEAD_LETTER_UNRESOLVED = "dl.resolved_at IS NULL";

export async function getDashboardMetrics(workspaceId: string, client: Queryable = db()): Promise<DashboardMetric[]> {
  // Roll the four overview counts into a single round-trip. Previously
  // these were four parallel `count(*)` queries, each grabbing its own
  // pool connection — on a cold Supabase pool this fanned out four
  // concurrent connection attempts before the page could render. Postgres
  // evaluates scalar subqueries inside a single result row independently,
  // so the planner cost is the same but we only hold one connection.
  const result = await client.query<{
    sources: string;
    active_sources: string;
    routes: string;
    destinations: string;
    dead_letters: string;
  }>(
    `SELECT
       (SELECT count(*)::text FROM sources WHERE workspace_id = $1) AS sources,
       (SELECT count(*)::text FROM sources WHERE workspace_id = $1 AND status = 'active') AS active_sources,
       (SELECT count(*)::text FROM routes WHERE workspace_id = $1) AS routes,
       (SELECT count(*)::text FROM destinations WHERE workspace_id = $1) AS destinations,
       (SELECT count(*)::text FROM dead_letters dl
         WHERE dl.workspace_id = $1 AND ${DEAD_LETTER_UNRESOLVED}) AS dead_letters`,
    [workspaceId],
  );
  const row = result.rows[0];

  return [
    { label: "Sources", value: row?.sources ?? "0" },
    { label: "Active sources", value: row?.active_sources ?? "0" },
    { label: "Routes", value: row?.routes ?? "0" },
    { label: "Destinations", value: row?.destinations ?? "0" },
    { label: "Failed deliveries", value: row?.dead_letters ?? "0" },
  ];
}

export async function listSources(workspaceId: string, client: Queryable = db()): Promise<SourceRow[]> {
  const result = await client.query<SourceRow>(
    `SELECT s.id,
            s.name,
            s.status,
            COALESCE(ps.type, 'webhook') AS source_kind,
            COALESCE(s.provider, 'custom') AS provider,
            s.max_events_per_minute,
            s.created_at::text
       FROM sources s
       LEFT JOIN pull_sources ps ON ps.id = s.id AND ps.workspace_id = s.workspace_id
      WHERE s.workspace_id = $1
      ORDER BY s.created_at DESC
      LIMIT 50`,
    [workspaceId],
  );
  return result.rows;
}

export async function listDeadLetters(workspaceId: string, client: Queryable = db()): Promise<DeliveryRow[]> {
  const result = await client.query<DeliveryRow>(
    `WITH unresolved AS MATERIALIZED (
       SELECT dl.id, dl.event_id, dl.route_id, dl.reason, dl.errored_at
         FROM dead_letters dl
        WHERE dl.workspace_id = $1
          AND ${DEAD_LETTER_UNRESOLVED}
      )
      SELECT id::text, event_id, route_id, reason, errored_at::text
        FROM unresolved
       ORDER BY errored_at DESC
       LIMIT 50`,
    [workspaceId],
  );
  return result.rows;
}

export async function listDeadLettersFull(workspaceId: string, client: Queryable = db()): Promise<DeadLetterFullRow[]> {
  const result = await client.query<DeadLetterFullRow>(
    `WITH unresolved AS MATERIALIZED (
       SELECT dl.id, dl.event_id, dl.source_id, dl.route_id, dl.r2_key, dl.reason, dl.message, dl.errored_at
         FROM dead_letters dl
        WHERE dl.workspace_id = $1
          AND ${DEAD_LETTER_UNRESOLVED}
      )
      SELECT
        u.id::text,
        u.event_id,
        u.source_id,
        u.route_id,
        u.r2_key,
        u.reason,
        u.message,
        u.errored_at::text,
        rr.id AS replay_id,
        rr.state AS replay_state,
        rr.requested_at::text AS replay_requested_at,
        rr.finished_at::text AS replay_finished_at,
        rr.error_message AS replay_error_message
        FROM unresolved u
        LEFT JOIN LATERAL (
          SELECT id, state, requested_at, finished_at, error_message
            FROM replay_requests rr
           WHERE rr.workspace_id = $1
             AND rr.event_id = u.event_id
             AND rr.scope = 'route'
             AND rr.route_id = u.route_id
             AND rr.requested_at > u.errored_at
           ORDER BY rr.requested_at DESC
           LIMIT 1
        ) rr ON true
       ORDER BY u.errored_at DESC
       LIMIT 50`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    ...row,
    message: sanitizeConnectorDiagnosticForStorage(row.message, 500),
    replay_error_message: row.replay_error_message
      ? sanitizeConnectorDiagnosticForStorage(row.replay_error_message, 500)
      : null,
  }));
}

export async function listReplayRequests(workspaceId: string, client: Queryable = db()): Promise<ReplayRequestRow[]> {
  const result = await client.query<ReplayRequestRow>(
    `SELECT id, event_id, source_id, scope, route_id, destination_id, state, reason,
            requested_at::text, finished_at::text, error_message
       FROM replay_requests
      WHERE workspace_id = $1
      ORDER BY replay_requests.requested_at DESC
      LIMIT 50`,
    [workspaceId],
  );
  return result.rows;
}

export async function countReplayRequests(workspaceId: string, client: Queryable = db()): Promise<number> {
  // Windowed to match the "Recent replays" label it feeds — the lifetime
  // count read as recent activity next to a 3-row list (ROL-628).
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM replay_requests
      WHERE workspace_id = $1
        AND requested_at >= now() - interval '30 days'`,
    [workspaceId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function countUnresolvedDeadLetters(workspaceId: string, client: Queryable = db()): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM dead_letters dl
      WHERE dl.workspace_id = $1
        AND ${DEAD_LETTER_UNRESOLVED}`,
    [workspaceId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export interface UnresolvedReasonRow {
  reason: string;
  count: number;
  active_replay_count: number;
  active_replay_pending_count: number;
  active_replay_in_progress_count: number;
  /** Most-recent dead_letter.id for this reason — used to deep-link
   * the "Fix with AI" CTA on the dashboard to /deliveries/{id}/investigate. */
  sample_dead_letter_id: string;
  /** Most-recent dead_letter.source_id — used by reasons whose fix lives on the source
   * (signature issues, ingest config). */
  sample_source_id: string;
}

/**
 * Counts every unresolved dead-letter grouped by reason and includes a
 * representative recent dead-letter id + source id per group so the
 * dashboard can deep-link the "Fix with AI" / "Fix source" CTAs.
 * The dashboard derives the Activity total from this same result so the
 * headline and reason rows cannot drift across separate cache entries.
 */
export async function countUnresolvedDeadLettersByReason(
  workspaceId: string,
  client: Queryable = db(),
): Promise<UnresolvedReasonRow[]> {
  const result = await client.query<{
    reason: string;
    count: string;
    sample_dead_letter_id: string;
    sample_source_id: string;
  }>(
    `SELECT dl.reason,
            count(*)::text AS count,
            (array_agg(dl.id::text     ORDER BY dl.errored_at DESC))[1] AS sample_dead_letter_id,
            (array_agg(dl.source_id    ORDER BY dl.errored_at DESC))[1] AS sample_source_id
       FROM dead_letters dl
      WHERE dl.workspace_id = $1
        AND ${DEAD_LETTER_UNRESOLVED}
      GROUP BY dl.reason
      ORDER BY count(*) DESC`,
    [workspaceId],
  );
  return result.rows.map((r) => ({
    reason: r.reason,
    count: Number(r.count),
    active_replay_count: 0,
    active_replay_pending_count: 0,
    active_replay_in_progress_count: 0,
    sample_dead_letter_id: r.sample_dead_letter_id,
    sample_source_id: r.sample_source_id,
  }));
}

export interface ActiveReplayReasonRow {
  reason: string;
  state: "pending" | "in_progress";
  count: number;
}

export async function countActiveReplayRequestsByReason(
  workspaceId: string,
  client: Queryable = db(),
): Promise<ActiveReplayReasonRow[]> {
  const result = await client.query<{
    reason: string;
    state: "pending" | "in_progress";
    count: string;
  }>(
    `SELECT failure_reason AS reason,
            state,
            count(*)::text AS count
       FROM replay_requests
      WHERE workspace_id = $1
        AND scope = 'route'
        AND state IN ('pending', 'in_progress')
        AND failure_reason IS NOT NULL
      GROUP BY failure_reason, state`,
    [workspaceId],
  );
  return result.rows.map((r) => ({
    reason: r.reason,
    state: r.state,
    count: Number(r.count),
  }));
}

export async function listTeamMembers(workspaceId: string, client: Queryable = db()): Promise<TeamMemberRow[]> {
  const result = await client.query<TeamMemberRow>(
    `SELECT u.id AS user_id, u.email, u.name, wm.role, wm.created_at::text
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
      ORDER BY CASE wm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, u.email ASC`,
    [workspaceId],
  );
  return result.rows;
}

export async function listInvites(workspaceId: string, client: Queryable = db()): Promise<InviteRow[]> {
  const result = await client.query<InviteRow>(
    `SELECT id, email, role, expires_at::text, accepted_at::text, created_at::text
       FROM workspace_invites
      WHERE workspace_id = $1
      ORDER BY created_at DESC
      LIMIT 50`,
    [workspaceId],
  );
  return result.rows;
}

// --- Cached read paths ---------------------------------------------------- //
//
// Wrappers used by server components that don't need a custom Queryable
// (i.e. always use the default pool). Tests call the un-cached versions
// directly with their own client; production page renders go through the
// cached path so dashboard navigations don't fan out a fresh PG round-trip
// on every click.
//
// Each wrapper uses a per-workspace tag so a mutation in workspace A
// doesn't bust workspace B's entries.

export function getDashboardMetricsCached(workspaceId: string): Promise<DashboardMetric[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => getDashboardMetrics(workspaceId),
    ["dashboard-metrics-v2", scope],
    {
      tags: [
        cacheTags.metrics(workspaceId),
        cacheTags.sources(workspaceId),
        cacheTags.routes(workspaceId),
        cacheTags.destinations(workspaceId),
        cacheTags.deadLetters(workspaceId),
      ],
      revalidate: DASHBOARD_REVALIDATE_SECONDS,
    },
  )();
}

export function listSourcesCached(workspaceId: string): Promise<SourceRow[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => listSources(workspaceId),
    ["dashboard-sources", scope],
    { tags: [cacheTags.sources(workspaceId)], revalidate: DASHBOARD_REVALIDATE_SECONDS },
  )();
}

export function listReplayRequestsCached(workspaceId: string): Promise<ReplayRequestRow[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => listReplayRequests(workspaceId),
    ["dashboard-replays", scope],
    { tags: [cacheTags.replays(workspaceId)], revalidate: DASHBOARD_REVALIDATE_SECONDS },
  )();
}

export function countReplayRequestsCached(workspaceId: string): Promise<number> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => countReplayRequests(workspaceId),
    ["dashboard-replays-count", scope],
    { tags: [cacheTags.replays(workspaceId)], revalidate: DASHBOARD_REVALIDATE_SECONDS },
  )();
}

export function countUnresolvedDeadLettersCached(workspaceId: string): Promise<number> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => countUnresolvedDeadLetters(workspaceId),
    ["dashboard-dead-letters-count-v2", scope],
    { tags: [cacheTags.deadLetters(workspaceId)], revalidate: DASHBOARD_REVALIDATE_SECONDS },
  )();
}

export function countUnresolvedDeadLettersByReasonCached(
  workspaceId: string,
): Promise<UnresolvedReasonRow[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => countUnresolvedDeadLettersByReason(workspaceId),
    ["dashboard-dead-letters-by-reason-v2", scope],
    { tags: [cacheTags.deadLetters(workspaceId)], revalidate: DASHBOARD_REVALIDATE_SECONDS },
  )();
}

export function countActiveReplayRequestsByReasonCached(
  workspaceId: string,
): Promise<ActiveReplayReasonRow[]> {
  const scope = workspaceCacheScope(workspaceId);
  return unstable_cache(
    () => countActiveReplayRequestsByReason(workspaceId),
    ["dashboard-active-replays-by-reason", scope],
    { tags: [cacheTags.replays(workspaceId)], revalidate: DASHBOARD_REVALIDATE_SECONDS },
  )();
}
