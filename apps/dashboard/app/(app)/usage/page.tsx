import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { StatCard } from "../../_components/StatCard";
import {
  deliveryRates,
  formatBytes,
  formatCount,
  getDailyUsage,
  getWorkspaceUsage,
  listWorkspaceFailureTypes,
  listSourceUsage,
  usageEnabled,
  type DailyUsageRow,
  type FailureTypeRow,
  type SourceUsageRow,
  type WorkspaceUsageSummary,
} from "../../../lib/usage";
import { requireSession } from "../../../lib/session";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

function trendLabel(current: number, previous: number): { label: string; tone: "up" | "down" | "flat" } {
  if (previous === 0) {
    return current === 0 ? { label: "—", tone: "flat" } : { label: "new", tone: "up" };
  }
  const delta = (current - previous) / previous;
  if (Math.abs(delta) < 0.005) return { label: "0%", tone: "flat" };
  const tone = delta >= 0 ? "up" : "down";
  return { label: `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(0)}%`, tone };
}

function describeBilling(summary: WorkspaceUsageSummary): string {
  // Billing is live (Stripe checkout/portal, metered usage, and quota gates all
  // ship). Surface the metered counter and when it rolls over for the period.
  return `Metered for billing on your current plan. Counter resets ${new Date(summary.windowEnd).toUTCString().slice(0, 16)} UTC.`;
}

export default async function UsagePage() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const timezone = session.activeWorkspace.workspace_timezone;

  if (!usageEnabled()) {
    return (
      <>
        <PageHeader eyebrow="Workspace" title="Usage" />
        <EmptyState
          title="Usage analytics not configured"
          body="Usage analytics are unavailable for this deployment. Contact the operator to enable them."
        />
      </>
    );
  }

  let summary: WorkspaceUsageSummary | null = null;
  let perSource: SourceUsageRow[] = [];
  let failureTypes: FailureTypeRow[] = [];
  let daily: DailyUsageRow[] = [];
  let error: string | null = null;
  try {
    [summary, perSource, failureTypes, daily] = await Promise.all([
      getWorkspaceUsage(workspaceId),
      listSourceUsage(workspaceId),
      listWorkspaceFailureTypes(workspaceId),
      getDailyUsage(workspaceId, 30, { timezone }),
    ]);
  } catch {
    error = "Usage analytics are temporarily unavailable.";
  }

  if (error || !summary) {
    return (
      <>
        <PageHeader eyebrow="Workspace" title="Usage" />
        <EmptyState
          title="Couldn't load usage stats"
          body={error ?? "Usage analytics are temporarily unavailable."}
        />
      </>
    );
  }

  const rates = deliveryRates(summary);
  const failedThisMonth = summary.retriesThisMonth + summary.deadDeliveriesThisMonth;
  const trend = trendLabel(summary.eventsThisMonth, summary.eventsPreviousMonth);
  const monthLabel = MONTH_FORMAT.format(new Date(summary.windowStart));
  const peakDay = daily.reduce<DailyUsageRow | null>(
    (max, row) => (max == null || row.events > max.events ? row : max),
    null,
  );
  const totalEventsLast30 = daily.reduce((acc, row) => acc + row.events, 0);

  const trendToneClass =
    trend.tone === "up"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : trend.tone === "down"
        ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
        : "border-border bg-muted text-muted-foreground";

  return (
    <>
      <PageHeader
        eyebrow={`Usage · ${monthLabel}`}
        title={`${formatCount(summary.eventsThisMonth)} events`}
        description={describeBilling(summary)}
        actions={
          <div
            className={`flex flex-col items-end rounded-lg border px-3 py-1.5 text-right ${trendToneClass}`}
          >
            <span className="font-mono text-sm font-semibold">{trend.label}</span>
            <small className="text-[11px] text-muted-foreground">vs. last month</small>
          </div>
        }
      />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Workspace usage">
        <StatCard
          label="Events received (30d)"
          value={formatCount(totalEventsLast30)}
          sub={peakDay ? `peak ${formatCount(peakDay.events)} on ${peakDay.day}` : "peak —"}
        />
        <StatCard
          label="Events (last 24h)"
          value={formatCount(summary.eventsLast24h)}
          sub="rolling window"
        />
        <StatCard
          label="Bytes ingested (this month)"
          value={formatBytes(summary.bytesThisMonth)}
          sub="raw payload size"
        />
        <StatCard
          label="Delivery attempts (this month)"
          value={formatCount(summary.deliveryAttemptsThisMonth)}
          sub={`${formatCount(summary.deliveriesSucceededThisMonth)} succeeded`}
        />
      </section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Delivery outcomes</h2>
            <Badge variant="outline">this month</Badge>
          </div>
          <div className="space-y-4 p-5">
            <RateRow
              label="Success"
              tone="success"
              percent={rates.success}
              count={summary.deliveriesSucceededThisMonth}
            />
            <RateRow
              label="Failure"
              tone="failure"
              percent={rates.failure}
              count={failedThisMonth}
            />
            <FailureTypeList rows={failureTypes} />
          </div>
        </section>

        <section className="rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">Top sources</h2>
            <Badge variant="outline">by volume</Badge>
          </div>
          {perSource.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Bytes</TableHead>
                  <TableHead>Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {perSource.map((row) => {
                  const share = summary.eventsThisMonth > 0 ? row.events / summary.eventsThisMonth : 0;
                  return (
                    <TableRow key={row.source_id}>
                      <TableCell>
                        <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                          {row.source_id}
                        </code>
                      </TableCell>
                      <TableCell className="text-sm">{formatCount(row.events)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{formatBytes(row.bytes)}</TableCell>
                      <TableCell className="text-sm">{(share * 100).toFixed(1)}%</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          ) : (
            <div className="p-5">
              <EmptyState
                title="No source activity yet"
                body="Once webhooks start hitting the ingest edge, the highest-volume sources will appear here."
              />
            </div>
          )}
        </section>
      </div>

      <section className="mt-6 rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">Daily volume</h2>
          <Badge variant="outline">last 30 days</Badge>
        </div>
        <div className="p-5">
          {daily.length ? (
            <DailyChart rows={daily} />
          ) : (
            <EmptyState
              title="No daily activity yet"
              body="Day-by-day volume will appear here once events flow."
            />
          )}
        </div>
      </section>
    </>
  );
}

function RateRow({
  label,
  tone,
  percent,
  count,
}: {
  label: string;
  tone: "success" | "failure";
  percent: number;
  count: number;
}) {
  const dotClass =
    tone === "success"
      ? "bg-emerald-500"
      : "bg-rose-500";
  const fillClass =
    tone === "success"
      ? "bg-emerald-500/70"
      : "bg-rose-500/70";
  return (
    <div className="grid grid-cols-[140px_1fr_120px] items-center gap-3">
      <div className="flex items-center gap-2 text-sm text-foreground">
        <span className={`size-2 rounded-full ${dotClass}`} aria-hidden="true" />
        {label}
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
        <div
          className={`h-full ${fillClass}`}
          style={{ width: `${(percent * 100).toFixed(1)}%` }}
        />
      </div>
      <div className="text-right">
        <strong className="font-mono text-sm font-semibold text-foreground">
          {(percent * 100).toFixed(2)}%
        </strong>
        <small className="ml-2 text-xs text-muted-foreground">{formatCount(count)}</small>
      </div>
    </div>
  );
}

function FailureTypeList({ rows }: { rows: FailureTypeRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2">
        <small className="text-xs text-muted-foreground">No failures recorded this month.</small>
      </div>
    );
  }
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-foreground">Failures by error type</span>
        <small className="text-xs text-muted-foreground">{formatCount(total)} total</small>
      </div>
      <ul className="space-y-1.5">
        {rows.slice(0, 5).map((row) => (
          <li key={row.error_type} className="flex items-center justify-between gap-3 text-sm">
            <span className="truncate text-muted-foreground" title={row.error_type}>{row.error_type}</span>
            <strong className="font-mono text-xs text-foreground">{formatCount(row.count)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DailyChart({ rows }: { rows: DailyUsageRow[] }) {
  const max = rows.reduce((acc, row) => Math.max(acc, row.events), 0);
  return (
    <div className="space-y-2">
      <div
        className="flex h-32 items-end gap-1"
        role="img"
        aria-label={`Daily events for the last ${rows.length} days`}
      >
        {rows.map((row) => {
          const heightPct = max > 0 ? Math.max(2, (row.events / max) * 100) : 2;
          return (
            <span
              key={row.day}
              className="group relative flex-1 rounded-sm bg-primary/70 transition-colors hover:bg-primary"
              style={{ height: `${heightPct}%` }}
              title={`${row.day}: ${row.events.toLocaleString("en-US")} events · ${formatBytes(row.bytes)}`}
            >
              <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-sm border border-border bg-popover px-1.5 py-0.5 font-mono text-[10px] font-semibold text-popover-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
                {formatCount(row.events)}
              </span>
            </span>
          );
        })}
      </div>
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground">
        <span>{rows[0]?.day ?? ""}</span>
        <span>{rows[rows.length - 1]?.day ?? ""}</span>
      </div>
    </div>
  );
}
