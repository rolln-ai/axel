/**
 * AXE-66 v2 — async backfill job worker.
 *
 * The dashboard inserts a single `backfill_jobs` row when an operator wants
 * to flush historical events into a route. This worker drains those jobs
 * by paginating ClickHouse and feeding `replay_requests` in throttled
 * chunks — never holding more than `max_inflight_replays` pending rows for
 * a single job at once.
 *
 * Why this shape:
 *   - One billion historical events is plausible for a real customer. A
 *     single ClickHouse SELECT into one HTTP response would OOM the
 *     dashboard; a single bulk INSERT into replay_requests would bloat
 *     Postgres and overwhelm the customer destination with a sudden flood.
 *   - The throttle bounds memory and bounds the rate at which the customer
 *     sees backfilled traffic — replays drain at the router's natural rate.
 *
 * Per-tick logic for a single job:
 *   1. Refresh job state — if cancelled/done/failed, drop it.
 *   2. Count pending replays linked to this job. If >= max_inflight_replays,
 *      skip — let the router drain the queue first.
 *   3. Pull the next ClickHouse window (cursor-based: rows after
 *      (cursor_received_at, cursor_event_id), up to BATCH_LIMIT).
 *   4. If empty → mark `done` and we're finished.
 *   5. Else bulk-INSERT into replay_requests, update cursor + enqueued.
 *
 * Idempotency: if the worker crashes between bulk-INSERT and cursor UPDATE,
 * the next run pulls the same window again. Two things guard against
 * duplicate replays: (1) the cursor UPDATE runs in the SAME transaction as
 * the bulk INSERT, so a crash rolls back both; and (2) a partial unique
 * index on (backfill_job_id, event_id) (migration 0039) backs an
 * ON CONFLICT DO NOTHING, so even a re-pulled window can't enqueue an
 * event's replay twice.
 */

import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { recoveryDeliveryState, recoveryRouteReady } from "./recovery-backfill.js";
import {
  startPeriodicRunner,
  type RunnerHandle,
} from "@axel/router";
import {
  isCanonicalRawPayloadKey,
  sanitizeConnectorDiagnosticForStorage,
} from "@axel/shared";

/** Max events pulled from ClickHouse per worker tick per job. */
const BATCH_LIMIT = 500;

/** Max jobs the worker advances per tick (per-job concurrency is 1 — round-robin). */
const MAX_JOBS_PER_TICK = 4;

interface BackfillJobRow {
  id: string;
  workspace_id: string;
  route_id: string;
  source_id: string;
  since: string;
  until: string;
  state: "pending" | "running" | "done" | "failed" | "cancelled";
  cursor_received_at: string | null;
  cursor_event_id: string | null;
  max_inflight_replays: number;
  recovery_destination_id?: string | null;
  recovery_route_updated_at?: string | null;
  enqueued: string; // bigint comes back as string from pg
}

interface ClickhouseEnv {
  url: string;
  user?: string;
  password?: string;
}

export interface BackfillWorkerDeps {
  pool: Pool;
  clickhouse: ClickhouseEnv;
  /** Defaults to 60s. */
  intervalMs?: number;
  /** Test injection. */
  fetchImpl?: typeof fetch;
  /** Test injection — overrides `new Date()`. */
  now?: () => Date;
}

interface ClickhouseRow {
  event_id: string;
  r2_key: string;
  // Aliased to *_text (not `received_at`) so the stringified value can't
  // shadow the typed `received_at` column in the WHERE/cursor comparisons —
  // see scripts/check-clickhouse-aliases.mjs.
  received_at_text: string;
}

const CLICKHOUSE_QUERY_MAX_MEMORY_BYTES = 512 * 1024 * 1024;
const CLICKHOUSE_QUERY_MAX_THREADS = 2;
const CLICKHOUSE_QUERY_MAX_EXECUTION_SECONDS = 10;
const CLICKHOUSE_QUERY_MAX_RESULT_ROWS = 10_000;

function toClickhouseDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace("Z", "");
}

function clickhouseToIso(raw: string): string {
  // ClickHouse "2026-05-18 12:34:56.789" → ISO "2026-05-18T12:34:56.789Z"
  return raw.replace(" ", "T") + "Z";
}

async function clickhouseQuery(
  env: ClickhouseEnv,
  sql: string,
  params: Record<string, string | number>,
  fetchImpl: typeof fetch,
): Promise<ClickhouseRow[]> {
  const url = new URL(env.url);
  url.searchParams.set("default_format", "JSON");
  url.searchParams.set("max_execution_time", String(CLICKHOUSE_QUERY_MAX_EXECUTION_SECONDS));
  url.searchParams.set("max_memory_usage", String(CLICKHOUSE_QUERY_MAX_MEMORY_BYTES));
  url.searchParams.set("max_bytes_before_external_group_by", String(Math.floor(CLICKHOUSE_QUERY_MAX_MEMORY_BYTES / 4)));
  url.searchParams.set("max_bytes_before_external_sort", String(Math.floor(CLICKHOUSE_QUERY_MAX_MEMORY_BYTES / 4)));
  url.searchParams.set("max_threads", String(CLICKHOUSE_QUERY_MAX_THREADS));
  url.searchParams.set("max_result_rows", String(CLICKHOUSE_QUERY_MAX_RESULT_ROWS));
  url.searchParams.set("result_overflow_mode", "break");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(`param_${k}`, String(v));
  }
  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=UTF-8",
    "X-ClickHouse-User": env.user ?? "default",
  };
  if (env.password) headers["X-ClickHouse-Key"] = env.password;
  const res = await fetchImpl(url, {
    method: "POST",
    redirect: "manual",
    body: sql,
    headers,
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`clickhouse_${res.status}`);
  }
  const text = await res.text();
  if (!text.trim()) return [];
  return ((JSON.parse(text) as { data?: ClickhouseRow[] }).data ?? []);
}

/**
 * Pull the next window of events for a job. Cursor-based: starts at
 * (cursor_received_at, cursor_event_id) if set, else at `since`. Always
 * stops at `until`. Returns ClickHouse rows in ascending order.
 */
async function fetchNextWindow(
  env: ClickhouseEnv,
  job: BackfillJobRow,
  fetchImpl: typeof fetch,
  limit: number,
): Promise<ClickhouseRow[]> {
  // Without a cursor we just use `since` as the lower bound. With a cursor,
  // we want strictly-after — `(received_at, event_id) > (cursor_rcv, cursor_evt)`
  // expressed as `received_at > cursor_rcv OR (received_at = cursor_rcv AND event_id > cursor_evt)`.
  const baseSince = job.cursor_received_at ?? job.since;
  const sinceParam = toClickhouseDateTime(new Date(baseSince));
  const untilParam = toClickhouseDateTime(new Date(job.until));

  if (job.cursor_received_at && job.cursor_event_id) {
    return clickhouseQuery(
      env,
      `SELECT event_id, r2_key, toString(received_at) AS received_at_text
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id    = {source_id:String}
          AND received_at >= parseDateTime64BestEffort({since:String}, 3)
          AND received_at <  parseDateTime64BestEffort({until:String}, 3)
          AND is_test = 0
          AND (
            received_at > parseDateTime64BestEffort({cursor_rcv:String}, 3)
            OR (
              received_at = parseDateTime64BestEffort({cursor_rcv:String}, 3)
              AND event_id > {cursor_evt:String}
            )
          )
        ORDER BY received_at ASC, event_id ASC
        LIMIT {lim:UInt32}`,
      {
        workspace_id: job.workspace_id,
        source_id: job.source_id,
        since: sinceParam,
        until: untilParam,
        cursor_rcv: toClickhouseDateTime(new Date(job.cursor_received_at)),
        cursor_evt: job.cursor_event_id,
        lim: limit,
      },
      fetchImpl,
    );
  }

  return clickhouseQuery(
    env,
    `SELECT event_id, r2_key, toString(received_at) AS received_at_text
       FROM events
      WHERE workspace_id = {workspace_id:String}
        AND source_id    = {source_id:String}
        AND received_at >= parseDateTime64BestEffort({since:String}, 3)
        AND received_at <  parseDateTime64BestEffort({until:String}, 3)
        AND is_test = 0
      ORDER BY received_at ASC, event_id ASC
      LIMIT {lim:UInt32}`,
    {
      workspace_id: job.workspace_id,
      source_id: job.source_id,
      since: sinceParam,
      until: untilParam,
      lim: limit,
    },
    fetchImpl,
  );
}

/**
 * Bulk-INSERT replay rows for a window. All in one transaction with the
 * cursor advance — crash anywhere rolls back both so the next worker run
 * pulls the same window.
 */
async function enqueueWindow(
  client: PoolClient,
  job: BackfillJobRow,
  rows: ClickhouseRow[],
  completed = new Set<string>(),
): Promise<void> {
  const values: unknown[] = [];
  const eligible = rows.filter(row => !completed.has(row.event_id));
  const tuples = eligible.map((r, j) => {
    const o = j * 10;
    values.push(
      `rpy_${randomBytes(16).toString("base64url")}`,
      job.workspace_id,
      r.event_id,
      job.source_id,
      r.r2_key,
      "route",
      job.route_id,
      null, // destination_id
      "pending",
      job.id, // backfill_job_id
    );
    return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10})`;
  });
  const inserted = tuples.length === 0 ? { rowCount: 0 } : await client.query(
    `INSERT INTO replay_requests
       (id, workspace_id, event_id, source_id, r2_key, scope, route_id, destination_id, state, backfill_job_id)
     VALUES ${tuples.join(",")}
     ON CONFLICT (backfill_job_id, event_id) WHERE backfill_job_id IS NOT NULL DO NOTHING`,
    values,
  );
  // A crash-replayed window re-pulls the same events; the partial unique
  // index (migration 0039) turns those into no-ops. Count actually-inserted
  // rows so `enqueued` doesn't over-count on a replayed window.
  const insertedCount = inserted.rowCount ?? eligible.length;

  const lastRow = rows[rows.length - 1]!;
  await client.query(
    `UPDATE backfill_jobs
        SET state = 'running',
            started_at = COALESCE(started_at, now()),
            cursor_received_at = $2,
            cursor_event_id = $3,
            enqueued = enqueued + $4,
            skipped = skipped + $5
      WHERE id = $1`,
    [job.id, clickhouseToIso(lastRow.received_at_text), lastRow.event_id, insertedCount, rows.length - eligible.length],
  );
}

async function markJobDone(pool: Pool, jobId: string): Promise<void> {
  await pool.query(
    `UPDATE backfill_jobs
        SET state = 'done',
            finished_at = now()
      WHERE id = $1
        AND state IN ('pending', 'running')`,
    [jobId],
  );
}

async function markJobFailed(pool: Pool, jobId: string, message: string): Promise<void> {
  await pool.query(
    `UPDATE backfill_jobs
        SET state = 'failed',
            finished_at = now(),
            error_message = $2
      WHERE id = $1
        AND state IN ('pending', 'running')`,
    [jobId, message.slice(0, 1000)],
  );
}

/**
 * Count pending replays linked to this job. Used to honor the per-job
 * throttle — when this hits `max_inflight_replays`, the worker stops
 * enqueueing more until the router drains the queue.
 */
async function countPendingReplays(pool: Pool, jobId: string): Promise<number> {
  const result = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM replay_requests
      WHERE backfill_job_id = $1
        AND state IN ('pending', 'in_progress')`,
    [jobId],
  );
  return Number.parseInt(result.rows[0]?.n ?? "0", 10);
}

/**
 * Claim up to N active jobs for this worker tick. Uses SKIP LOCKED so
 * multiple delivery-service replicas don't pick up the same job. We do
 * NOT transition state here — that happens lazily inside `advanceJob`
 * (cursor UPDATE doubles as the state→running transition).
 */
async function claimActiveJobs(pool: Pool, limit: number): Promise<BackfillJobRow[]> {
  // We use FOR UPDATE SKIP LOCKED but don't actually update — the SELECT
  // holds the row lock until commit. To release immediately we use a
  // single SELECT (the per-job state transitions happen in their own
  // transactions). Simpler: just SELECT — the worst case under
  // concurrent replicas is one wasted ClickHouse window per duplicated
  // claim, which is harmless because the cursor advance is idempotent.
  const result = await pool.query<BackfillJobRow>(
    `SELECT id, workspace_id, route_id, source_id,
            since::text AS since,
            until::text AS until,
            state,
            cursor_received_at::text AS cursor_received_at,
            cursor_event_id,
            max_inflight_replays,
            recovery_destination_id, recovery_route_updated_at::text AS recovery_route_updated_at,
            enqueued::text AS enqueued
       FROM backfill_jobs
      WHERE state IN ('pending', 'running')
      ORDER BY requested_at ASC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/**
 * Advance a single job by at most one ClickHouse window. Returns whether
 * progress was made (used by tests; the worker doesn't care).
 */
export async function advanceJob(
  deps: BackfillWorkerDeps,
  job: BackfillJobRow,
): Promise<"advanced" | "throttled" | "done" | "cancelled" | "failed"> {
  // Re-read state — operator may have cancelled since we claimed.
  const freshResult = await deps.pool.query<{ state: string }>(
    `SELECT state FROM backfill_jobs WHERE id = $1 LIMIT 1`,
    [job.id],
  );
  const freshState = freshResult.rows[0]?.state;
  if (!freshState) return "cancelled";
  if (freshState === "cancelled") return "cancelled";
  if (freshState === "done" || freshState === "failed") return freshState as "done" | "failed";

  if (job.recovery_destination_id) {
    if (!await recoveryRouteReady(deps.pool, job)) {
      await markJobFailed(deps.pool, job.id, "recovery_route_unavailable_or_changed");
      return "failed";
    }
    const failed = await deps.pool.query(`SELECT 1 FROM replay_requests WHERE backfill_job_id=$1 AND state='failed' LIMIT 1`, [job.id]);
    if (failed.rows.length > 0) {
      await markJobFailed(deps.pool, job.id, "recovery_delivery_failed");
      return "failed";
    }
  }
  const pending = await countPendingReplays(deps.pool, job.id);
  if (pending >= job.max_inflight_replays) return "throttled";

  let rows: ClickhouseRow[];
  try {
    rows = await fetchNextWindow(deps.clickhouse, job, deps.fetchImpl ?? fetch, Math.min(BATCH_LIMIT, job.max_inflight_replays - pending));
  } catch (err) {
    const reason = sanitizeConnectorDiagnosticForStorage(
      err instanceof Error ? err.message : "unknown",
      500,
    );
    await markJobFailed(deps.pool, job.id, reason);
    return "failed";
  }

  if (rows.length === 0) {
    if (pending > 0) return "throttled";
    await markJobDone(deps.pool, job.id);
    return "done";
  }

  if (rows.some((row) => (job.recovery_destination_id && row.event_id.includes("#")) || !isCanonicalRawPayloadKey(row.r2_key, {
    workspaceId: job.workspace_id,
    eventId: row.event_id,
    sourceId: job.source_id,
  }))) {
    await markJobFailed(deps.pool, job.id, "raw_payload_key_mismatch");
    return "failed";
  }

  // Single transaction: bulk INSERT + cursor advance. Crash in between
  // rolls back both, so the next tick pulls the same window.
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    let completed = new Set<string>();
    if (job.recovery_destination_id) {
      const fresh = (await client.query(`SELECT state, cursor_received_at::text AS cursor_received_at, cursor_event_id
        FROM backfill_jobs WHERE id=$1 FOR UPDATE`, [job.id])).rows[0];
      if (!fresh || !["pending", "running"].includes(fresh.state)
          || fresh.cursor_received_at !== job.cursor_received_at || fresh.cursor_event_id !== job.cursor_event_id) {
        await client.query("ROLLBACK");
        return "throttled";
      }
      if (!await recoveryRouteReady(client, job, true)) throw new Error("recovery_route_unavailable_or_changed");
      const delivery = await recoveryDeliveryState(client, job, rows.map(row => row.event_id));
      if (delivery.busy) {
        await client.query("ROLLBACK");
        return "throttled";
      }
      completed = delivery.completed;
    }
    await enqueueWindow(client, job, rows, completed);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const reason = sanitizeConnectorDiagnosticForStorage(
      err instanceof Error ? err.message : "unknown",
      500,
    );
    await markJobFailed(deps.pool, job.id, reason);
    return "failed";
  } finally {
    client.release();
  }
  return "advanced";
}

/**
 * One worker tick: claim a handful of active jobs and advance each by one
 * window. Designed to be cheap if there are no active jobs (single SELECT).
 */
export async function runBackfillWorkerOnce(deps: BackfillWorkerDeps): Promise<{
  jobs: number;
  advanced: number;
  throttled: number;
  finished: number;
}> {
  const jobs = await claimActiveJobs(deps.pool, MAX_JOBS_PER_TICK);
  let advanced = 0;
  let throttled = 0;
  let finished = 0;
  for (const job of jobs) {
    const result = await advanceJob(deps, job);
    if (result === "advanced") advanced += 1;
    else if (result === "throttled") throttled += 1;
    else finished += 1;
  }
  return { jobs: jobs.length, advanced, throttled, finished };
}

export function startBackfillJobWorker(deps: BackfillWorkerDeps): RunnerHandle {
  const intervalMs = deps.intervalMs ?? 60_000;
  return startPeriodicRunner([
    {
      name: "backfill_job_processor",
      intervalMs,
      run: async () => {
        const summary = await runBackfillWorkerOnce(deps);
        if (summary.jobs > 0) {
          console.log(
            `[backfill-jobs] tick: ${summary.jobs} job(s) — advanced=${summary.advanced} throttled=${summary.throttled} finished=${summary.finished}`,
          );
        }
      },
    },
  ]);
}
