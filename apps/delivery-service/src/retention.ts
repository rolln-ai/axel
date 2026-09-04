/**
 * AXE-35 — retention enforcement.
 *
 * Per-workspace retention defaults (raw_payload, dead_letter,
 * replay_request, audit_log) with optional per-source raw_payload
 * overrides + `transient_mode` shortcut (= 0 days).
 *
 * The cleanup query is intentionally:
 *   * idempotent — re-running yields zero deletes on a clean DB.
 *   * bounded — `LIMIT N` per pass so a single statement can't lock the
 *     table for long. When `drain` is set the loop repeats the bounded
 *     pass until the category is empty (or a tick budget is hit), so a
 *     large backlog clears within a tick instead of leaking N rows/tick.
 *   * dry-run capable — `dryRun: true` returns counts without
 *     mutating, useful for the admin endpoint that previews scope.
 *
 * Note: `enforceRetention` itself only purges Postgres rows — it does
 * NOT delete R2 raw-payload bytes, and `raw_payload_retention_days`
 * does not reach them here. R2 byte deletion is handled by:
 *   * the fixed, bucket-wide 30-day lifecycle rule
 *     (infra/cloudflare/r2-lifecycle.json) — the ceiling/backstop; and
 *   * `sweepRawPayloadRetention` (r2-retention.ts), run from the
 *     retention loop below, which deletes bytes EARLY for workspaces /
 *     sources whose effective raw retention is under 30 days.
 * Deleting a dead_letters/replay row that points at an r2_key just
 * removes the pointer; the byte expires under one of the two above.
 */

import type pg from "pg";
import { recordHeartbeat } from "@axel/observability";
import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";
import type { R2RetentionSummary } from "./r2-retention.js";

export interface RetentionSummary {
  dead_letters_deleted: number;
  replay_requests_deleted: number;
  audit_log_deleted: number;
  delivery_idempotency_deleted: number;
  user_sessions_deleted: number;
  workspace_invites_deleted: number;
  notifications_deleted: number;
  erasure_subjects_deleted: number;
}

const ZERO_SUMMARY: RetentionSummary = {
  dead_letters_deleted: 0,
  replay_requests_deleted: 0,
  audit_log_deleted: 0,
  delivery_idempotency_deleted: 0,
  user_sessions_deleted: 0,
  workspace_invites_deleted: 0,
  notifications_deleted: 0,
  erasure_subjects_deleted: 0,
};

// Notifications grow slowly (deduped, one row per real condition) but nothing
// else prunes them. Fixed-age cleanup: read notifications clear quickly, unread
// ones linger longer in case the user hasn't looked yet.
const NOTIFICATION_READ_RETENTION_DAYS = 90;
const NOTIFICATION_UNREAD_RETENTION_DAYS = 180;

// The GDPR subject→event index (erasure_subjects) locates a data subject's
// events for erasure. It points at raw R2 payloads (30-day lifecycle) and
// ClickHouse `events` (30-day TTL), so a row older than that window is a
// dangling locator — the finder would falsely report the data still exists.
// Prune at 30 days so the index never outlives the data it points to.
const ERASURE_SUBJECT_RETENTION_DAYS = 30;

export interface RetentionOptions {
  /** Cap per category per pass. Default 5000. */
  limitPerCategory?: number;
  /** When true, only count rows; no DELETE. Forces a single pass. */
  dryRun?: boolean;
  /**
   * When true, each category is swept repeatedly until a pass deletes
   * fewer than `limitPerCategory` rows (drained) or the tick budget is
   * hit. Without this, each category deletes at most `limitPerCategory`
   * rows per call — which at high ingest volume (e.g. delivery_idempotency
   * at 10M/day) can't keep up. Ignored when `dryRun`.
   */
  drain?: boolean;
  /** Safety cap on drain passes per category. Default 200 (= 1M rows/category at the default limit). */
  maxPassesPerCategory?: number;
  /** Wall-clock budget for one enforceRetention run (ms). Default 120000. */
  tickBudgetMs?: number;
  /** Injectable monotonic clock (ms) for the drain budget. Default Date.now. */
  clock?: () => number;
  now?: () => Date;
}

const DEFAULT_LIMIT = 5000;
const DEFAULT_MAX_PASSES = 200;
const DEFAULT_TICK_BUDGET_MS = 120_000;

export async function enforceRetention(
  pool: pg.Pool,
  options: RetentionOptions = {},
): Promise<RetentionSummary> {
  const limit = options.limitPerCategory ?? DEFAULT_LIMIT;
  const dryRun = options.dryRun ?? false;
  const drain = (options.drain ?? false) && !dryRun;
  const maxPasses = options.maxPassesPerCategory ?? DEFAULT_MAX_PASSES;
  const clock = options.clock ?? Date.now;
  const deadline = clock() + (options.tickBudgetMs ?? DEFAULT_TICK_BUDGET_MS);
  const summary: RetentionSummary = { ...ZERO_SUMMARY };

  const runCategory = (onePass: () => Promise<number>): Promise<number> =>
    drainCategory(onePass, { drain, limit, maxPasses, deadline, clock });

  // Dead letters use the per-workspace dead_letter_retention_days.
  summary.dead_letters_deleted = await runCategory(() =>
    deleteByWorkspaceRetention(pool, {
      selectSql: `
      SELECT dl.ctid AS row_tid
        FROM dead_letters dl
        JOIN workspaces w ON w.id = dl.workspace_id
       WHERE dl.errored_at < now() - (w.dead_letter_retention_days || ' days')::interval
       LIMIT $1`,
      deleteSql: `DELETE FROM dead_letters WHERE ctid = ANY($1::tid[])`,
      limit,
      dryRun,
    }),
  );
  // Replays use replay_request_retention_days. Column is
  // `requested_at`, not `created_at` (this bug shipped in #89 and
  // caused the retention loop to throw on every tick — which then
  // made retention-loop's heartbeat row carry a non-empty
  // last_error and show RED on /admin/health).
  summary.replay_requests_deleted = await runCategory(() =>
    deleteByWorkspaceRetention(pool, {
      selectSql: `
      SELECT rr.id AS row_tid
        FROM replay_requests rr
        JOIN workspaces w ON w.id = rr.workspace_id
       WHERE rr.requested_at < now() - (w.replay_request_retention_days || ' days')::interval
         AND rr.state IN ('done', 'failed')
       LIMIT $1`,
      deleteSql: `DELETE FROM replay_requests WHERE id = ANY($1::text[])`,
      limit,
      dryRun,
      idType: "text",
    }),
  );
  // Audit log uses audit_log_retention_days.
  summary.audit_log_deleted = await runCategory(() =>
    deleteByWorkspaceRetention(pool, {
      selectSql: `
      SELECT al.ctid AS row_tid
        FROM audit_log al
        JOIN workspaces w ON w.id = al.workspace_id
       WHERE al.created_at < now() - (w.audit_log_retention_days || ' days')::interval
       LIMIT $1`,
      deleteSql: `DELETE FROM audit_log WHERE ctid = ANY($1::tid[])`,
      limit,
      dryRun,
    }),
  );
  // Expiry-based cleanups. These rows carry an absolute expires_at, so
  // there is no per-workspace retention join. Previously these lived in
  // apps/router's runCleanupPass, which never deployed (since removed) — so in production
  // they grew unbounded. delivery_idempotency is the critical one: an active
  // row carries its renewable claim deadline, then terminal settlement moves
  // expires_at to now()+14d. Without pruning, terminal rows reach tens of
  // millions and degrade the ON CONFLICT claim on the delivery hot path. This
  // is why the loop drains the table per tick.
  summary.delivery_idempotency_deleted = await runCategory(() =>
    deleteExpired(pool, {
      table: "delivery_idempotency",
      limit,
      dryRun,
    }),
  );
  summary.user_sessions_deleted = await runCategory(() =>
    deleteExpired(pool, {
      table: "user_sessions",
      limit,
      dryRun,
    }),
  );
  summary.workspace_invites_deleted = await runCategory(() =>
    deleteExpired(pool, {
      table: "workspace_invites",
      extraWhere: "accepted_at IS NULL",
      limit,
      dryRun,
    }),
  );
  // Notifications: fixed-age delete (read 90d / unread 180d). Not an
  // expires_at table and not workspace-retention-scoped, so it has its own
  // bounded, drain-aware category.
  summary.notifications_deleted = await runCategory(() =>
    deleteOldNotifications(pool, { limit, dryRun }),
  );
  // GDPR erasure index: prune rows older than the data they locate (30d).
  summary.erasure_subjects_deleted = await runCategory(() =>
    deleteOldErasureSubjects(pool, { limit, dryRun }),
  );
  return summary;
}

/**
 * Repeat a bounded single-pass delete until it drains the category (a pass
 * returns fewer than `limit` rows) or a safety/budget limit is hit. With
 * `drain` off it runs exactly one pass (the legacy behaviour, and what
 * dryRun previews).
 */
async function drainCategory(
  onePass: () => Promise<number>,
  opts: { drain: boolean; limit: number; maxPasses: number; deadline: number; clock: () => number },
): Promise<number> {
  let total = 0;
  const passes = opts.drain ? opts.maxPasses : 1;
  for (let i = 0; i < passes; i += 1) {
    const n = await onePass();
    total += n;
    if (n < opts.limit) break; // category drained
    if (opts.clock() >= opts.deadline) break; // tick budget hit; resume next tick
  }
  return total;
}

interface CategoryQuery {
  selectSql: string;
  deleteSql: string;
  limit: number;
  dryRun: boolean;
  idType?: "tid" | "text";
}

async function deleteByWorkspaceRetention(
  pool: pg.Pool,
  args: CategoryQuery,
): Promise<number> {
  const found = await pool.query<{ row_tid: string }>(args.selectSql, [args.limit]);
  const foundCount = found.rowCount ?? 0;
  if (foundCount === 0) return 0;
  if (args.dryRun) return foundCount;
  const ids = found.rows.map((r) => r.row_tid);
  const deleted = await pool.query(args.deleteSql, [ids]);
  return deleted.rowCount ?? 0;
}

interface ExpiredQuery {
  /** Table name. Hardcoded call-site literal — never user input. */
  table: string;
  /** Optional extra predicate ANDed onto `expires_at < now()`. Literal. */
  extraWhere?: string;
  limit: number;
  dryRun: boolean;
}

/**
 * Bounded delete of rows whose absolute `expires_at` has passed. Uses a
 * `ctid IN (… LIMIT $1)` subselect so each pass is capped (a backlog just
 * gets cleared over multiple passes) and the expires_at index does the work.
 */
async function deleteExpired(pool: pg.Pool, args: ExpiredQuery): Promise<number> {
  const extra = args.extraWhere ? ` AND ${args.extraWhere}` : "";
  if (args.dryRun) {
    const found = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM (SELECT 1 FROM ${args.table}
                WHERE expires_at < now()${extra}
                LIMIT $1) s`,
      [args.limit],
    );
    return Number(found.rows[0]?.count ?? 0);
  }
  const deleted = await pool.query(
    `DELETE FROM ${args.table}
      WHERE ctid IN (SELECT ctid FROM ${args.table}
                      WHERE expires_at < now()${extra}
                      LIMIT $1)`,
    [args.limit],
  );
  return deleted.rowCount ?? 0;
}

/**
 * Bounded fixed-age delete of notifications: read rows past
 * NOTIFICATION_READ_RETENTION_DAYS, unread rows past
 * NOTIFICATION_UNREAD_RETENTION_DAYS. `ctid IN (… LIMIT $1)` keeps each pass
 * capped so the drain loop can clear a backlog over multiple passes.
 */
async function deleteOldNotifications(
  pool: pg.Pool,
  args: { limit: number; dryRun: boolean },
): Promise<number> {
  const predicate = `(
        (read_at IS NOT NULL AND read_at < now() - ($2 || ' days')::interval)
     OR (read_at IS NULL     AND created_at < now() - ($3 || ' days')::interval)
  )`;
  const params = [
    args.limit,
    String(NOTIFICATION_READ_RETENTION_DAYS),
    String(NOTIFICATION_UNREAD_RETENTION_DAYS),
  ];
  if (args.dryRun) {
    const found = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM (SELECT 1 FROM notifications WHERE ${predicate} LIMIT $1) s`,
      params,
    );
    return Number(found.rows[0]?.count ?? 0);
  }
  const deleted = await pool.query(
    `DELETE FROM notifications
      WHERE ctid IN (SELECT ctid FROM notifications WHERE ${predicate} LIMIT $1)`,
    params,
  );
  return deleted.rowCount ?? 0;
}

/**
 * Fixed-age purge of the GDPR subject→event index (erasure_subjects). Keyed on
 * `received_at` (the event's ingest time — the same basis as the ClickHouse
 * `events` TTL and R2 lifecycle), so an index row is dropped once the data it
 * points to has expired. Bounded + drain-aware like the other categories.
 */
async function deleteOldErasureSubjects(
  pool: pg.Pool,
  args: { limit: number; dryRun: boolean },
): Promise<number> {
  const predicate = `received_at < now() - ($2 || ' days')::interval`;
  const params = [args.limit, String(ERASURE_SUBJECT_RETENTION_DAYS)];
  if (args.dryRun) {
    const found = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM (SELECT 1 FROM erasure_subjects WHERE ${predicate} LIMIT $1) s`,
      params,
    );
    return Number(found.rows[0]?.count ?? 0);
  }
  const deleted = await pool.query(
    `DELETE FROM erasure_subjects
      WHERE ctid IN (SELECT ctid FROM erasure_subjects WHERE ${predicate} LIMIT $1)`,
    params,
  );
  return deleted.rowCount ?? 0;
}

export interface RetentionLoopOptions {
  /** Loop interval. Default 1 hour. */
  intervalMs?: number;
  /** Drain each category until empty per tick. Default true. */
  drain?: boolean;
  maxPassesPerCategory?: number;
  tickBudgetMs?: number;
  /**
   * Optional raw-payload R2 sweep run each tick after the PG retention pass.
   * Wired in server.ts when ClickHouse + Cloudflare creds are present. Runs in
   * its own failure domain — a sweep error never fails the PG retention tick.
   */
  rawPayloadSweep?: () => Promise<R2RetentionSummary>;
}

/**
 * Schedule `enforceRetention` (and, if configured, the raw-payload R2 sweep)
 * to run on a loop. Returns the timer handle so callers can `clearInterval`
 * during graceful shutdown.
 *
 * Default interval is 1 hour — retention isn't sensitive to a few minutes of
 * skew, and running too often saturates PG with tombstones.
 */
export function startRetentionLoop(
  pool: pg.Pool,
  options: RetentionLoopOptions = {},
): NodeJS.Timeout {
  const intervalMs = options.intervalMs ?? 60 * 60 * 1000;
  let tickCount = 0;
  const tick = async (): Promise<void> => {
    tickCount += 1;
    let lastError: string | undefined;
    let summary: RetentionSummary = { ...ZERO_SUMMARY };
    let r2Summary: R2RetentionSummary | undefined;
    try {
      summary = await enforceRetention(pool, {
        drain: options.drain ?? true,
        ...(options.maxPassesPerCategory != null ? { maxPassesPerCategory: options.maxPassesPerCategory } : {}),
        ...(options.tickBudgetMs != null ? { tickBudgetMs: options.tickBudgetMs } : {}),
      });
      const total =
        summary.dead_letters_deleted +
        summary.replay_requests_deleted +
        summary.audit_log_deleted +
        summary.delivery_idempotency_deleted +
        summary.user_sessions_deleted +
        summary.workspace_invites_deleted +
        summary.notifications_deleted;
      if (total > 0) {
        console.log(`[retention] purged ${total} rows`, summary);
      }
    } catch (err) {
      lastError = sanitizeConnectorDiagnosticForStorage(err);
      console.error(`[retention] tick failed: ${lastError}`);
    }
    // Raw-payload R2 sweep — separate failure domain so a Cloudflare/ClickHouse
    // hiccup doesn't redden the PG retention heartbeat.
    if (options.rawPayloadSweep) {
      try {
        r2Summary = await options.rawPayloadSweep();
        if (r2Summary.keys_deleted > 0 || r2Summary.keys_failed > 0 || r2Summary.budget_exhausted) {
          console.log("[retention] r2 raw-payload sweep", r2Summary);
        }
      } catch (err) {
        console.error(
          `[retention] r2 raw-payload sweep failed: ${sanitizeConnectorDiagnosticForStorage(err)}`,
        );
      }
    }
    // Snapshot every component's current health status into the
    // 7-day uptime history. Cheap (a few rows per tick), and the
    // ON CONFLICT clause means a re-run within the same hour just
    // overwrites with the latest status. Prune older than 7d.
    try {
      await captureHeartbeatHistory(pool);
    } catch (err) {
      console.error(
        `[retention] heartbeat history capture failed: ${sanitizeConnectorDiagnosticForStorage(err)}`,
      );
    }
    // Heartbeat after the tick (success or failure). Interval is
    // hourly, so the badge tolerance is 2× the interval to allow a
    // single missed tick before alerting.
    void recordHeartbeat(pool, {
      component: "retention-loop",
      tickCount,
      ...(lastError ? { error: lastError } : {}),
      metadata: {
        ...summary,
        ...(r2Summary ? { r2: r2Summary } : {}),
      } as unknown as Record<string, unknown>,
      expectedIntervalSeconds: Math.ceil((intervalMs / 1000) * 2),
    });
  };
  // Kick off once shortly after boot so the first run isn't 60min
  // out; idempotent so retries are safe.
  const initial = setTimeout(tick, 30_000);
  initial.unref();
  return setInterval(tick, intervalMs);
}

/**
 * Snapshot the current `component_heartbeats` table into a
 * (component, bucket_start) row in component_heartbeat_history,
 * then prune rows older than 7 days. Bucket is the start of the
 * current hour. ON CONFLICT lets re-runs in the same hour
 * overwrite (the loop runs more often than once per hour
 * defensively, so this matters).
 *
 * Status derivation matches `deriveStatus` in the dashboard:
 *   - last_error non-null → red
 *   - staleness >= 2× expected_interval → red
 *   - staleness >=    expected_interval → yellow
 *   - otherwise → green
 */
async function captureHeartbeatHistory(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO component_heartbeat_history (component, bucket_start, status)
     SELECT
       component,
       date_trunc('hour', now()) AS bucket_start,
       CASE
         WHEN last_error IS NOT NULL AND last_error <> '' THEN 'red'
         WHEN EXTRACT(EPOCH FROM (now() - last_seen)) >= expected_interval_seconds * 2 THEN 'red'
         WHEN EXTRACT(EPOCH FROM (now() - last_seen)) >= expected_interval_seconds THEN 'yellow'
         ELSE 'green'
       END AS status
     FROM component_heartbeats
     ON CONFLICT (component, bucket_start)
     DO UPDATE SET status = EXCLUDED.status`,
  );
  await pool.query(
    `DELETE FROM component_heartbeat_history
      WHERE bucket_start < now() - interval '7 days'`,
  );
}
