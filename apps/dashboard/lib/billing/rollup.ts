import "server-only";
import { hasClickhouseUrl } from "../clickhouse";
import type { ClickhouseQueryable } from "../clickhouse";
import { clickhouse } from "../clickhouse";
import type { Queryable } from "../db";
import { db } from "../db";

const BILLING_CLICKHOUSE_QUERY_TIMEOUT_MS = 30_000;

/**
 * Recompute current-period (calendar-month UTC) task counts for every
 * workspace and upsert into `workspace_usage_period`.
 *
 * Billing definition (axelapp.ai/pricing):
 *   - 1 metered event per accepted webhook (one row in clickhouse.events)
 *   - Destination pushes and retries are not billable
 *   - Test events (is_test=true) are not billable
 *
 * Initial delivery pushes are still rolled up into delivery_tasks for
 * operational analytics, but total_tasks is generated from ingest_tasks only.
 *
 * Idempotent by design: each run replaces the prior row's totals with
 * a fresh ClickHouse aggregate. Running the cron twice for the same
 * period converges to the same value rather than double-counting. The
 * cron can also safely backfill earlier months by passing `now` set
 * to a date in that month.
 */

export interface BillingRollupSummary {
  /** First day of the period (`YYYY-MM-01` UTC) — the row key. */
  periodStart: string;
  /** Number of workspaces with non-zero activity this period. */
  workspaceCount: number;
  /** Sum across all workspaces of accepted ingest tasks this period. */
  ingestTasks: number;
  /** Sum across all workspaces of first-attempt delivery tasks this period. */
  deliveryTasks: number;
  /** Wall-clock duration of the rollup run, ms. */
  durationMs: number;
}

export interface BillingRollupDeps {
  ch?: ClickhouseQueryable;
  pg?: Queryable;
  now?: Date;
}

export async function runBillingRollup(
  deps: BillingRollupDeps = {},
): Promise<BillingRollupSummary> {
  const startMs = Date.now();
  const now = deps.now ?? new Date();

  // Calendar-month UTC period anchor. We use the same period_start
  // regardless of Stripe subscription anchor: the billing model in
  // the pricing page is per calendar month, and Stripe handles its
  // own per-subscription invoice period internally via meter events.
  const periodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const nextPeriodStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
  );
  const periodStartKey = isoDateKey(periodStart);

  const ch = deps.ch ?? requireClickhouse();
  const merged = new Map<string, { ingest: number; delivery: number }>();

  // events / delivery_attempts are plain MergeTree tables and Cloudflare Queues is
  // at-least-once, so a requeue after a successful ClickHouse write leaves
  // duplicate rows. count() would overbill; dedupe by the same identity the /usage
  // dashboard uses (uniqExact(event_id) for ingest; the distinct
  // (event_id, route_id, destination_id) delivery for delivery) so the invoice
  // matches what the customer sees.
  const ingestRows = await ch.query<{ workspace_id: string; tasks: string }>(
    `SELECT workspace_id, uniqExact(event_id) AS tasks
       FROM events
      WHERE received_at >= {start:DateTime64(3)}
        AND received_at < {end:DateTime64(3)}
        AND is_test = false
      GROUP BY workspace_id`,
    { start: chTimestamp(periodStart), end: chTimestamp(nextPeriodStart) },
  );

  const deliveryRows = await ch.query<{ workspace_id: string; tasks: string }>(
    `SELECT workspace_id, uniqExact(event_id, route_id, destination_id) AS tasks
       FROM delivery_attempts
      WHERE created_at >= {start:DateTime64(3)}
        AND created_at < {end:DateTime64(3)}
        AND attempt_no = 1
        AND is_test = false
      GROUP BY workspace_id`,
    { start: chTimestamp(periodStart), end: chTimestamp(nextPeriodStart) },
  );

  for (const row of ingestRows.rows) {
    merged.set(row.workspace_id, { ingest: parseTaskCount(row.tasks), delivery: 0 });
  }
  for (const row of deliveryRows.rows) {
    const tasks = parseTaskCount(row.tasks);
    const existing = merged.get(row.workspace_id);
    if (existing) existing.delivery = tasks;
    else merged.set(row.workspace_id, { ingest: 0, delivery: tasks });
  }

  const pg = deps.pg ?? db();
  // Drop workspace_ids that no longer exist in Postgres before billing them.
  // ClickHouse is NOT wiped when a workspace is hard-deleted (deleteWorkspaceAction
  // only removes the Postgres row), so its events/delivery_attempts rows persist
  // as orphans. workspace_usage_period.workspace_id REFERENCES workspaces(id), so
  // upserting an orphan FK-violates — and since the upsert is one transaction it
  // would roll back the entire rollup for every workspace. Same guard as the
  // notification-scan cron (lib/notification-scan.ts). (JAVASCRIPT-2F class)
  await filterToExistingWorkspaces(pg, merged);

  // Totals are summed after filtering so a deleted workspace's orphaned
  // ClickHouse activity is excluded from the reported sums too.
  let totalIngest = 0;
  let totalDelivery = 0;
  for (const counts of merged.values()) {
    totalIngest += counts.ingest;
    totalDelivery += counts.delivery;
  }

  // Upsert in a single transaction so a partial failure doesn't leave
  // the table half-written. The reported_to_stripe_at column is
  // intentionally untouched here — only the Stripe meter forwarder
  // (PR-3) sets it.
  await upsertUsage(pg, periodStartKey, merged);

  return {
    periodStart: periodStartKey,
    workspaceCount: merged.size,
    ingestTasks: totalIngest,
    deliveryTasks: totalDelivery,
    durationMs: Date.now() - startMs,
  };
}

/**
 * Remove workspace_ids that have no row in the Postgres `workspaces` table.
 * The rollup sources ids from ClickHouse, which retains a workspace's events
 * after it is hard-deleted; without this guard those orphans would violate
 * workspace_usage_period's FK to workspaces and roll back the whole upsert.
 */
async function filterToExistingWorkspaces(
  pg: Queryable,
  merged: Map<string, { ingest: number; delivery: number }>,
): Promise<void> {
  if (merged.size === 0) return;
  const ids = Array.from(merged.keys());
  const result = await pg.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE id = ANY($1::text[])`,
    [ids],
  );
  const live = new Set(result.rows.map((r) => r.id));
  for (const id of ids) {
    if (!live.has(id)) merged.delete(id);
  }
}

function requireClickhouse(): ClickhouseQueryable {
  if (!hasClickhouseUrl()) {
    throw new Error("CLICKHOUSE_URL is required for the billing rollup");
  }
  // Unbounded: the rollup GROUP BYs workspace_id over EVERY active workspace.
  // The default max_result_rows/break cap would silently drop workspaces past
  // the cap — they'd never be metered, billed, or quota-capped.
  // Billing is background work with a five-minute cron budget. Give transient
  // ClickHouse stalls longer than the interactive dashboard's eight-second
  // fail-fast timeout, and retry timeout aborts just like transient 5xxs.
  return clickhouse({
    unbounded: true,
    timeoutMs: BILLING_CLICKHOUSE_QUERY_TIMEOUT_MS,
    retryTimeouts: true,
  });
}

async function upsertUsage(
  pg: Queryable | { connect: () => Promise<{
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number | null }>;
    release: () => void;
  }> },
  periodStartKey: string,
  merged: Map<string, { ingest: number; delivery: number }>,
): Promise<void> {
  // Real pg.Pool exposes `.connect()` for transactions; the test
  // double passes a Queryable that just exposes `.query()`. Branch on
  // whether `.connect` is present.
  if (merged.size === 0) return;
  if ("connect" in pg && typeof pg.connect === "function") {
    const client = await pg.connect();
    try {
      await client.query("BEGIN");
      for (const [workspaceId, counts] of merged) {
        await client.query(usageUpsertSql, [
          workspaceId,
          periodStartKey,
          counts.ingest,
          counts.delivery,
        ]);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return;
  }
  // Test fallback — no transaction wrapper, fine for the unit tests.
  for (const [workspaceId, counts] of merged) {
    await (pg as Queryable).query(usageUpsertSql, [
      workspaceId,
      periodStartKey,
      counts.ingest,
      counts.delivery,
    ]);
  }
}

const usageUpsertSql = `
  INSERT INTO workspace_usage_period
    (workspace_id, period_start, ingest_tasks, delivery_tasks, updated_at)
  VALUES ($1, $2, $3, $4, now())
  ON CONFLICT (workspace_id, period_start) DO UPDATE
    SET ingest_tasks = EXCLUDED.ingest_tasks,
        delivery_tasks = EXCLUDED.delivery_tasks,
        updated_at = now()
`;

function isoDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chTimestamp(d: Date): string {
  // ClickHouse DateTime64(3) parameter format: 'YYYY-MM-DD HH:MM:SS.fff'.
  // toISOString gives `YYYY-MM-DDTHH:MM:SS.fffZ`; swap the separator
  // and drop the Z (CH treats values as UTC by default).
  return d.toISOString().replace("T", " ").replace(/Z$/, "");
}

function parseTaskCount(raw: unknown): number {
  // ClickHouse returns count() as a string in JSON output to avoid
  // precision loss on very large numbers; coerce defensively and
  // floor any non-integers we might encounter from future schema
  // shape changes.
  if (typeof raw === "number") return Math.max(0, Math.floor(raw));
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
