import { PageHeader } from "../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../lib/admin-auth";
import {
  describeStatus,
  EXPECTED_COMPONENTS,
  getUptimeHistory,
  listComponentHealth,
  overallStatus,
  uptimeLabel,
  type ComponentHealth,
  type ComponentStatus,
  type UptimeBucket,
} from "../../../../lib/component-health";
import { UptimeSparkline } from "../../../_components/UptimeSparkline";

export const dynamic = "force-dynamic";

/**
 * Per-component heartbeat view — full operator surface with last
 * error, metadata, last seen, expected interval, tick count.
 * Sister to the public /status page (which shows the sanitised
 * subset).
 */
export default async function AdminHealthPage() {
  // Defense in depth same as overview/page.tsx — layout already
  // gates this route but in-flight parallel RSC rendering can
  // leak data if we don't repeat the check before fetching.
  await requireSuperAdmin();
  const [items, uptime] = await Promise.all([listComponentHealth(), getUptimeHistory()]);
  const overall = overallStatus(items);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Component health"
        description="Per-worker heartbeats. red/yellow badge means the loop is stale or threw on its last tick. Reload to re-probe."
      />

      <section
        className={`mb-6 rounded-lg border px-5 py-4 ${
          overall === "green"
            ? "border-green-300 bg-green-50 text-green-900 dark:border-green-700 dark:bg-green-950 dark:text-green-100"
            : overall === "yellow"
            ? "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
            : overall === "red"
            ? "border-red-300 bg-red-50 text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
            : "border-border bg-card"
        }`}
      >
        <p className="text-base font-semibold">
          Overall:{" "}
          {overall === "green"
            ? "All workers reporting healthy heartbeats"
            : overall === "yellow"
            ? "At least one worker has a stale heartbeat or has never reported"
            : overall === "red"
            ? "At least one worker is down or threw on its last tick"
            : "No heartbeats yet"}
        </p>
        <p className="mt-1 text-xs">
          Probed at <time>{new Date().toISOString()}</time>.{" "}
          {EXPECTED_COMPONENTS.length} expected components.
        </p>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-5 py-3 text-sm font-semibold text-foreground">Components</h2>
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Component</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">7-day uptime</th>
              <th className="px-3 py-2 font-medium">Last seen</th>
              <th className="px-3 py-2 font-medium">Tick #</th>
              <th className="px-3 py-2 font-medium">Expected</th>
              <th className="px-3 py-2 font-medium">Last error</th>
              <th className="px-3 py-2 font-medium">Metadata</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <HealthRow key={item.component} item={item} buckets={uptime.get(item.component) ?? []} />
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Expected components</h2>
        <p className="text-xs text-muted-foreground">
          New workers must call <code className="font-mono">recordHeartbeat</code> on each tick
          AND add themselves to <code className="font-mono">EXPECTED_COMPONENTS</code> in
          <code className="ml-1 font-mono">lib/component-health.ts</code>. Without the latter,
          a worker that never starts up is invisible to this page.
        </p>
        <ul className="mt-3 space-y-1.5 text-xs">
          {EXPECTED_COMPONENTS.map((c) => (
            <li key={c.name} className="text-muted-foreground">
              <code className="font-mono text-foreground">{c.name}</code> — {c.description}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function HealthRow({ item, buckets }: { item: ComponentHealth; buckets: ReadonlyArray<UptimeBucket> }) {
  const label = uptimeLabel(buckets);
  return (
    <tr className="border-t border-border align-top">
      <td className="px-3 py-2">
        <div className="font-medium text-foreground">{item.component}</div>
        {item.environment ? (
          <div className="text-[11px] text-muted-foreground">env: {item.environment}</div>
        ) : null}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={item.status} />
      </td>
      <td className="px-3 py-2">
        <div className="flex w-48 flex-col gap-1">
          {buckets.length > 0 ? <UptimeSparkline buckets={buckets} /> : (
            <span className="text-[11px] text-muted-foreground">no history yet</span>
          )}
          <small className="text-[11px] text-muted-foreground">
            {label ?? "not enough data"}
          </small>
        </div>
      </td>
      <td className="px-3 py-2 text-xs">
        {item.last_seen ? (
          <>
            <time>{item.last_seen}</time>
            <div className="text-[11px] text-muted-foreground">
              {item.staleness_seconds !== null
                ? `${item.staleness_seconds}s ago`
                : "unknown"}
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">never</span>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs">{item.last_tick_count.toLocaleString()}</td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {item.expected_interval_seconds}s
      </td>
      <td className="px-3 py-2 text-xs">
        {item.last_error ? (
          <code className="block max-w-md break-words text-red-700 dark:text-red-400">
            {item.last_error}
          </code>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-3 py-2 text-xs">
        {Object.keys(item.metadata).length > 0 ? (
          <pre className="max-w-md overflow-x-auto text-[11px] text-muted-foreground">
            {JSON.stringify(item.metadata, null, 2)}
          </pre>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function StatusBadge({ status }: { status: ComponentStatus }) {
  const cls =
    status === "green"
      ? "bg-green-500/15 text-green-700 dark:text-green-400"
      : status === "yellow"
      ? "bg-amber-500/15 text-amber-700 dark:text-amber-400"
      : status === "red"
      ? "bg-red-500/15 text-red-700 dark:text-red-400"
      : "bg-muted text-muted-foreground";
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
      title={describeStatus(status)}
    >
      {status}
    </span>
  );
}
