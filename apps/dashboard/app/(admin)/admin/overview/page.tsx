import { PageHeader } from "../../../_components/PageHeader";
import { requireSuperAdmin } from "../../../../lib/admin-auth";
import { getBillingOverviewTotals } from "../../../../lib/admin-billing";
import {
  getOverviewCounts,
  getSourceKindCounts,
  getDestinationTypeCounts,
} from "../../../../lib/admin-queries";
import { getGlobalEventTotals } from "../../../../lib/admin-metrics";

export const dynamic = "force-dynamic";

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log10(bytes) / 3));
  return `${(bytes / Math.pow(1000, i)).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

export default async function AdminOverviewPage() {
  // Defense in depth: the layout already gates this route, but Next.js
  // renders pages and layouts in parallel — without this call the page's
  // data fetches start (and complete) before the layout's redirect throws,
  // and their output leaks into the RSC stream served to anon callers.
  await requireSuperAdmin();
  const [counts, sourceKinds, destinationTypes, eventTotals, billing] = await Promise.all([
    getOverviewCounts(),
    getSourceKindCounts(),
    getDestinationTypeCounts(),
    getGlobalEventTotals().catch(() => null),
    getBillingOverviewTotals().catch(() => null),
  ]);

  return (
    <>
      <PageHeader
        eyebrow="Admin"
        title="Platform overview"
        description="Cross-workspace counts. Numbers refresh on each page load."
      />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Workspaces" value={formatNumber(counts.workspaceCount)} accent={counts.suspendedWorkspaceCount > 0 ? `${counts.suspendedWorkspaceCount} suspended` : "all active"} />
        <Tile label="Users" value={formatNumber(counts.userCount)} accent={`${counts.superAdminCount} super-admin`} />
        <Tile label="Active sessions" value={formatNumber(counts.activeSessionCount)} />
        <Tile label="Routes" value={formatNumber(counts.routeCount)} />
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Billing</h2>
        {billing ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Tile
              label="MRR (est.)"
              value={`$${(billing.mrrCentsEstimate / 100).toFixed(2)}`}
              accent={billing.overageCentsEstimate > 0
                ? `+$${(billing.overageCentsEstimate / 100).toFixed(2)} overage`
                : "no overage yet"}
            />
            <Tile
              label="Active Pro subs"
              value={formatNumber(billing.activeProCount)}
              accent={billing.attentionCount > 0 ? `${billing.attentionCount} need attention` : "all healthy"}
            />
            <Tile
              label="Tasks this period"
              value={formatNumber(billing.tasksThisPeriod)}
            />
            <Tile
              label="Free over cap"
              value={formatNumber(billing.freeWorkspacesOverCap)}
              accent={billing.freeWorkspacesOverCap > 0 ? "ingest 429'd" : "all under 10k"}
            />
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
            Billing data unavailable.
          </p>
        )}
      </section>

      <section className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        <CountTable title="Sources by kind" total={counts.sourceCount} rows={sourceKinds} />
        <CountTable title="Destinations by type" total={counts.destinationCount} rows={destinationTypes} />
      </section>

      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Event volume (cross-workspace)</h2>
        {eventTotals ? (
          <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            <Stat dt="Events (30d)" dd={formatNumber(eventTotals.eventsLast30d)} />
            <Stat dt="Bytes (30d)" dd={formatBytes(eventTotals.bytesLast30d)} />
            <Stat dt="Events (24h)" dd={formatNumber(eventTotals.eventsLast24h)} />
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">
            ClickHouse not configured (<code className="font-mono text-xs">CLICKHOUSE_URL</code>) —
            event volume rollups unavailable.
          </p>
        )}
      </section>
    </>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground">{value}</p>
      {accent ? <p className="mt-0.5 text-[11px] text-muted-foreground">{accent}</p> : null}
    </div>
  );
}

function Stat({ dt, dd }: { dt: string; dd: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{dt}</dt>
      <dd className="mt-0.5 font-mono text-lg text-foreground">{dd}</dd>
    </div>
  );
}

function CountTable({ title, total, rows }: { title: string; total: number; rows: { type: string; count: number }[] }) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{formatNumber(total)} total</span>
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((row) => (
            <li key={row.type} className="flex items-center justify-between px-5 py-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">{row.type}</span>
              <span className="font-medium text-foreground">{formatNumber(row.count)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
