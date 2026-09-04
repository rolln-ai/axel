import "server-only";
import type Stripe from "stripe";
import { clickhouse, hasClickhouseUrl, type ClickhouseQueryable } from "../clickhouse";
import type { Queryable } from "../db";
import { db } from "../db";
import { hasStripeConfigured, stripeClient } from "./stripe-client";

/**
 * Pushes per-workspace per-day task counts to the Stripe Meter so
 * Pro subscriptions are invoiced correctly.
 *
 * Strategy: for each Pro workspace, push ONE meter event per
 * (workspace, day) with `identifier = ${workspace_id}:${day}`. Stripe
 * dedupes meter events by identifier (per meter), so re-runs after a
 * backfill or transient failure converge rather than double-billing.
 *
 * The day is "yesterday in UTC" by default — the hourly billing
 * rollup runs at `:00`, this runs as the last step and reports the
 * day that just closed. The first invocation in a month will only
 * report the previous day's data; Stripe's invoice period
 * accumulates the meter values across the period automatically.
 *
 * Free workspaces are skipped — no Stripe customer/meter exists.
 *
 * Configuration:
 *   - STRIPE_SECRET_KEY (already required for any Stripe operation)
 *   - STRIPE_METER_EVENT_NAME — the `event_name` of the configured
 *     inbound-only meter; defaults to "axel_inbound_events".
 */

const METER_EVENT_NAME_DEFAULT = "axel_inbound_events";
const BILLING_CLICKHOUSE_QUERY_TIMEOUT_MS = 30_000;

export interface MeterReportSummary {
  /** YYYY-MM-DD UTC of the day reported. */
  day: string;
  /** Workspaces with at least one task on that day (and a Stripe customer). */
  reported: number;
  /** Workspaces skipped because they had zero billable inbound events that day. */
  skipped: number;
  /** Workspaces flagged Pro without a stripe_customer_id (config drift). */
  unbound: number;
  /** Per-workspace events the SDK accepted. */
  events: Array<{ workspaceId: string; tasks: number; identifier: string }>;
}

export interface MeterReporterDeps {
  ch?: ClickhouseQueryable;
  pg?: Queryable;
  meterEventName?: string;
  /** Override to a fixed reference date in tests / backfills. */
  now?: Date;
  /** Injected Stripe client (for tests). */
  stripe?: Pick<Stripe, "billing">;
}

export async function reportMeterEvents(
  deps: MeterReporterDeps = {},
): Promise<MeterReportSummary> {
  if (!deps.stripe && !hasStripeConfigured()) {
    throw new Error("STRIPE_SECRET_KEY is required for meter forwarding");
  }
  const stripe = (deps.stripe ?? stripeClient()) as Pick<Stripe, "billing">;
  const meterEventName =
    deps.meterEventName ?? process.env.STRIPE_METER_EVENT_NAME ?? METER_EVENT_NAME_DEFAULT;

  // "Yesterday" in UTC — the day that has fully closed at the time of
  // the hourly cron's first run on a new day.
  const now = deps.now ?? new Date();
  const yesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1),
  );
  const today = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const day = yesterday.toISOString().slice(0, 10);

  const pg = deps.pg ?? db();
  const ch = deps.ch ?? requireClickhouse();

  // Build (workspace_id → stripe_customer_id) only for Pro workspaces;
  // free workspaces have no Stripe customer to bill against.
  const customers = await pg.query<{ id: string; stripe_customer_id: string | null }>(
    `SELECT id, stripe_customer_id
       FROM workspaces
      WHERE plan = 'pro'`,
  );
  const customerByWs = new Map<string, string>();
  let unbound = 0;
  for (const row of customers.rows) {
    if (row.stripe_customer_id) customerByWs.set(row.id, row.stripe_customer_id);
    else unbound += 1;
  }

  if (customerByWs.size === 0) {
    return { day, reported: 0, skipped: 0, unbound, events: [] };
  }

  // Per-workspace accepted inbound totals for the closed day. Destination
  // pushes and retries are operational telemetry, never billable usage.
  const chStart = chTimestamp(yesterday);
  const chEnd = chTimestamp(today);
  const wsList = [...customerByWs.keys()];
  const ingest = await ch.query<{ workspace_id: string; tasks: string }>(
    // uniqExact (not count()) so a Cloudflare-Queues at-least-once requeue
    // that re-wrote a duplicate ClickHouse row doesn't OVERBILL the customer.
    `SELECT workspace_id, uniqExact(event_id) AS tasks
       FROM events
      WHERE received_at >= {start:DateTime64(3)}
        AND received_at < {end:DateTime64(3)}
        AND is_test = false
        AND workspace_id IN ({wsList:Array(String)})
      GROUP BY workspace_id`,
    { start: chStart, end: chEnd, wsList: chStringArray(wsList) },
  );

  const totals = new Map<string, number>();
  for (const row of ingest.rows) totals.set(row.workspace_id, parseTaskCount(row.tasks));

  // Push one meter event per (workspace, day). Stripe Meter Events
  // are deduplicated server-side by `identifier`, so a re-run is
  // safe. Reporting is best-effort per workspace — one workspace
  // failing should not block the rest.
  const events: MeterReportSummary["events"] = [];
  let reported = 0;
  let skipped = 0;
  const stripeTimestamp = Math.floor(yesterday.getTime() / 1000) + 12 * 60 * 60;
  for (const [workspaceId, customerId] of customerByWs) {
    const tasks = totals.get(workspaceId) ?? 0;
    if (tasks <= 0) {
      skipped += 1;
      continue;
    }
    const identifier = `${workspaceId}:${day}`;
    try {
      await stripe.billing.meterEvents.create({
        event_name: meterEventName,
        identifier,
        timestamp: stripeTimestamp,
        payload: {
          stripe_customer_id: customerId,
          value: String(tasks),
        },
      });
      events.push({ workspaceId, tasks, identifier });
      reported += 1;
    } catch {
      // Soft-fail per workspace. The cron's caller logs the summary;
      // we report the SDK message so /admin/billing/webhooks can show
      // it later. A retry next hour with the same identifier is safe.
      events.push({
        workspaceId,
        tasks,
        identifier: `${identifier}:error`,
      });
    }
  }

  // Mark the period_start row as reported so /admin can show "Last
  // pushed to Stripe at ...". The flag is per-period rather than
  // per-day because the period_start row is what /settings/billing
  // reads to show the user's current usage.
  if (reported > 0) {
    const periodStartKey = isoDateKey(
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    );
    await pg.query(
      `UPDATE workspace_usage_period
          SET reported_to_stripe_at = now()
        WHERE period_start = $1
          AND workspace_id = ANY($2::text[])`,
      [periodStartKey, [...customerByWs.keys()]],
    );
  }

  return { day, reported, skipped, unbound, events };
}

/**
 * Report a single workspace's un-invoiced usage for the CURRENT billing period
 * to the Stripe meter. Used by workspace teardown to bill every event the
 * customer sent right up to deletion before their ClickHouse data is wiped.
 *
 * Emits one meter event per (workspace, day) from the 1st of the month through
 * today. Stripe dedupes by the `${workspaceId}:${day}` identifier — identical to
 * the hourly cron's — so days already reported are no-ops and only today's (and
 * any not-yet-reported) usage is added. MUST run before deleteWorkspaceClickhouseRows.
 */
export async function flushWorkspaceMeterUsage(
  args: { workspaceId: string; stripeCustomerId: string },
  deps: MeterReporterDeps = {},
): Promise<{ reported: number; days: number }> {
  if (!deps.stripe && !hasStripeConfigured()) {
    throw new Error("STRIPE_SECRET_KEY is required for meter flushing");
  }
  const stripe = (deps.stripe ?? stripeClient()) as Pick<Stripe, "billing">;
  const meterEventName =
    deps.meterEventName ?? process.env.STRIPE_METER_EVENT_NAME ?? METER_EVENT_NAME_DEFAULT;
  const ch = deps.ch ?? requireClickhouse();

  const now = deps.now ?? new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // Through the end of "today" (start of tomorrow, UTC) so today's partial-day
  // usage is included — sources are already paused, so it won't grow further.
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );

  const ingest = await ch.query<{ day: string; tasks: string }>(
    // uniqExact mirrors reportMeterEvents / rollup.ts so the flushed total
    // matches what the customer saw on /usage — never bill more than shown.
    `SELECT toDate(received_at) AS day, uniqExact(event_id) AS tasks
       FROM events
      WHERE received_at >= {start:DateTime64(3)} AND received_at < {end:DateTime64(3)}
        AND is_test = false
        AND workspace_id = {ws:String}
      GROUP BY day`,
    { start: chTimestamp(periodStart), end: chTimestamp(periodEnd), ws: args.workspaceId },
  );

  const perDay = new Map<string, number>();
  for (const r of ingest.rows) perDay.set(r.day, (perDay.get(r.day) ?? 0) + parseTaskCount(r.tasks));

  const nowSec = Math.floor(now.getTime() / 1000);
  let reported = 0;
  for (const [day, tasks] of perDay) {
    if (tasks <= 0) continue;
    await stripe.billing.meterEvents.create({
      event_name: meterEventName,
      identifier: `${args.workspaceId}:${day}`,
      timestamp: nowSec,
      payload: { stripe_customer_id: args.stripeCustomerId, value: String(tasks) },
    });
    reported += 1;
  }
  return { reported, days: perDay.size };
}

function requireClickhouse(): ClickhouseQueryable {
  if (!hasClickhouseUrl()) {
    throw new Error("CLICKHOUSE_URL is required for meter forwarding");
  }
  // Unbounded: meter forwarding aggregates per-workspace usage across all
  // workspaces; the default break cap would silently under-report past the cap.
  // Meter forwarding shares the five-minute billing cron budget, so it can
  // tolerate a longer query than an interactive dashboard request and retry a
  // transient client-side timeout without delaying page loads.
  return clickhouse({
    unbounded: true,
    timeoutMs: BILLING_CLICKHOUSE_QUERY_TIMEOUT_MS,
    retryTimeouts: true,
  });
}

function chTimestamp(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/Z$/, "");
}

function isoDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function chStringArray(strings: string[]): string {
  // ClickHouse Array(String) HTTP parameter format is ['a','b','c'] —
  // single-quoted, with backslash and single-quote escaped inside
  // values. JSON.stringify uses double quotes which ClickHouse rejects
  // ("Cannot parse quoted string: expected opening quote ''', got '\"'").
  const escapeValue = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `[${strings.map((s) => `'${escapeValue(s)}'`).join(",")}]`;
}

function parseTaskCount(raw: unknown): number {
  if (typeof raw === "number") return Math.max(0, Math.floor(raw));
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
