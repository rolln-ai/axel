import "server-only";
import { db } from "./db";

/**
 * Component health summary — read by /admin/health (full operator
 * view) and /status (public sanitised view).
 *
 * `staleness_seconds` = now() - last_seen
 * Status thresholds:
 *   green  : staleness < expected_interval_seconds
 *   yellow : staleness < expected_interval_seconds * 2
 *   red    : staleness >= expected_interval_seconds * 2 OR
 *            last_error is non-empty AND was recorded after the
 *            last successful tick
 */

export type ComponentStatus = "green" | "yellow" | "red" | "unknown";

export interface ComponentHealth {
  component: string;
  environment: string | null;
  last_seen: string | null;
  last_tick_count: number;
  last_error: string | null;
  metadata: Record<string, unknown>;
  expected_interval_seconds: number;
  staleness_seconds: number | null;
  status: ComponentStatus;
}

/**
 * The full set of components the admin/status pages render. If a
 * component isn't in this list it's never expected to beat (so it
 * doesn't show up as missing). New workers should add themselves
 * here at the same time as they call recordHeartbeat.
 */
export const EXPECTED_COMPONENTS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "delivery-service", description: "Render Node worker that polls the CF delivery queue and runs connectors." },
  { name: "retention-loop", description: "Hourly cleanup job inside delivery-service that purges expired rows per workspace retention settings." },
  { name: "pull-worker", description: "Render Node worker that pulls from API + DB sources on a schedule." },
  { name: "ingest-worker", description: "Cloudflare Worker accepting inbound webhooks and writing to R2 + the shard queues." },
  { name: "router-edge", description: "Cloudflare Worker consuming shard queues, evaluating routes, and enqueuing per-destination delivery." },
  { name: "delivery-edge", description: "Cloudflare Worker delivering HTTP / webhook / R2 / S3 / Postgres destinations — the hottest delivery runtime." },
];

export async function listComponentHealth(): Promise<ComponentHealth[]> {
  const result = await db().query<{
    component: string;
    environment: string | null;
    last_seen: string | null;
    last_tick_count: string; // bigint comes back as string
    last_error: string | null;
    metadata: Record<string, unknown> | null;
    expected_interval_seconds: number;
    staleness_seconds: number | null;
  }>(
    `SELECT component,
            environment,
            last_seen::text AS last_seen,
            last_tick_count,
            last_error,
            metadata,
            expected_interval_seconds,
            EXTRACT(EPOCH FROM (now() - last_seen))::int AS staleness_seconds
       FROM component_heartbeats`,
  );
  const rows = new Map<string, ComponentHealth>();
  for (const r of result.rows) {
    rows.set(r.component, {
      component: r.component,
      environment: r.environment,
      last_seen: r.last_seen,
      last_tick_count: Number(r.last_tick_count),
      last_error: r.last_error,
      metadata: r.metadata ?? {},
      expected_interval_seconds: r.expected_interval_seconds,
      staleness_seconds: r.staleness_seconds,
      status: deriveStatus(r.staleness_seconds, r.expected_interval_seconds, r.last_error),
    });
  }
  // Fill in any expected-but-missing components as "unknown" so the
  // operator sees that a worker has NEVER beat (vs. is just stale).
  for (const expected of EXPECTED_COMPONENTS) {
    if (!rows.has(expected.name)) {
      rows.set(expected.name, {
        component: expected.name,
        environment: null,
        last_seen: null,
        last_tick_count: 0,
        last_error: null,
        metadata: {},
        expected_interval_seconds: 60,
        staleness_seconds: null,
        status: "unknown",
      });
    }
  }
  return [...rows.values()].sort((a, b) => a.component.localeCompare(b.component));
}

export function deriveStatus(
  stalenessSeconds: number | null,
  expectedIntervalSeconds: number,
  lastError: string | null,
): ComponentStatus {
  if (stalenessSeconds === null) return "unknown";
  if (lastError) return "red";
  if (stalenessSeconds >= expectedIntervalSeconds * 2) return "red";
  if (stalenessSeconds >= expectedIntervalSeconds) return "yellow";
  return "green";
}

export function describeStatus(status: ComponentStatus): string {
  switch (status) {
    case "green":
      return "operational";
    case "yellow":
      return "degraded (stale heartbeat)";
    case "red":
      return "down or stalled";
    case "unknown":
      return "no heartbeat yet";
  }
}

/**
 * Roll the per-component statuses into a single overall verdict for
 * the page banner. red anywhere → outage; yellow anywhere → degraded;
 * everything green → operational; any unknown without rebellion → degraded.
 */
export function overallStatus(items: ReadonlyArray<ComponentHealth>): ComponentStatus {
  if (items.length === 0) return "unknown";
  if (items.some((i) => i.status === "red")) return "red";
  if (items.some((i) => i.status === "yellow" || i.status === "unknown")) return "yellow";
  return "green";
}

/** Missing evidence cannot establish health, even when every HTTP probe passes. */
export function combineHealthStatus(
  probes: ReadonlyArray<{ ok: boolean }>,
  heartbeatStatus: ComponentStatus,
): "operational" | "degraded" | "outage" {
  if (heartbeatStatus === "red" || (probes.length > 0 && probes.every((probe) => !probe.ok))) {
    return "outage";
  }
  if (heartbeatStatus !== "green" || probes.length === 0 || probes.some((probe) => !probe.ok)) {
    return "degraded";
  }
  return "operational";
}

/**
 * 7-day uptime history per component. Returns one row per (component,
 * hour bucket) for the last 7×24 = 168 buckets. Buckets that have no
 * row (because the snapshot loop hadn't started yet, or the worker
 * had never reported) are returned as `unknown` so the sparkline
 * draws a continuous strip rather than a gappy one.
 */
export interface UptimeBucket {
  bucket_start: string;
  status: ComponentStatus;
}

export const UPTIME_BUCKETS = 7 * 24; // 168

export async function getUptimeHistory(): Promise<Map<string, UptimeBucket[]>> {
  const result = await db().query<{
    component: string;
    bucket_start: string;
    status: ComponentStatus;
  }>(
    `SELECT component, bucket_start::text AS bucket_start, status
       FROM component_heartbeat_history
      WHERE bucket_start >= date_trunc('hour', now()) - interval '7 days' + interval '1 hour'
      ORDER BY component, bucket_start`,
  );
  // Build the canonical 168-bucket spine (oldest → newest) so every
  // component renders the same number of bars even when there's no
  // data for some hours.
  const now = new Date();
  const topOfHour = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0,
  ));
  const spine: string[] = [];
  for (let i = UPTIME_BUCKETS - 1; i >= 0; i--) {
    const d = new Date(topOfHour.getTime() - i * 60 * 60 * 1000);
    spine.push(d.toISOString());
  }
  // Group fetched rows by component → bucket_start (normalised to
  // ISO string with no fractional seconds).
  const byComponent = new Map<string, Map<string, ComponentStatus>>();
  for (const r of result.rows) {
    const iso = new Date(r.bucket_start).toISOString();
    const inner = byComponent.get(r.component) ?? new Map<string, ComponentStatus>();
    inner.set(iso, r.status);
    byComponent.set(r.component, inner);
  }
  const out = new Map<string, UptimeBucket[]>();
  for (const [component, inner] of byComponent) {
    out.set(
      component,
      spine.map((bucket_start) => ({
        bucket_start,
        status: inner.get(bucket_start) ?? "unknown",
      })),
    );
  }
  // Fill in expected components that have NO history at all so the
  // sparkline still renders (all-unknown).
  for (const expected of EXPECTED_COMPONENTS) {
    if (!out.has(expected.name)) {
      out.set(
        expected.name,
        spine.map((bucket_start) => ({ bucket_start, status: "unknown" })),
      );
    }
  }
  return out;
}

/**
 * Roll a 168-bucket history into a single uptime percentage —
 * what fraction of the buckets were "green". `unknown` buckets are
 * excluded from the denominator so a worker that started reporting
 * 3 days ago doesn't get penalised for the 4 prior days.
 *
 * Returns null when fewer than `minBuckets` observations exist (so
 * a freshly-deployed worker with 1 hour of data doesn't show
 * "100.00% uptime · 7d" — that's accurate but misleading. Caller
 * should fall back to the live-status text in that case).
 */
export function uptimePercent(
  buckets: ReadonlyArray<UptimeBucket>,
  minBuckets = 2,
): number | null {
  const observed = buckets.filter((b) => b.status !== "unknown");
  if (observed.length < minBuckets) return null;
  const green = observed.filter((b) => b.status === "green").length;
  return (green / observed.length) * 100;
}

/**
 * For the per-row UI suffix. When uptime % is available, label it
 * by the actual observed window ("12h" not "7d") so we don't claim
 * 7 days of data when only 12 hours exist. Less misleading.
 */
export function uptimeLabel(buckets: ReadonlyArray<UptimeBucket>): string | null {
  const observed = buckets.filter((b) => b.status !== "unknown");
  if (observed.length < 2) return null;
  const pct = uptimePercent(buckets);
  if (pct === null) return null;
  const windowLabel = observed.length >= 24 * 7
    ? "7d"
    : observed.length >= 24
    ? `${Math.floor(observed.length / 24)}d`
    : `${observed.length}h`;
  return `${pct.toFixed(2)}% uptime · ${windowLabel}`;
}
