import { cache, Suspense, type ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Webhook, Wrench } from "lucide-react";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { KpiCard } from "../../_components/KpiCard";
import { EntityStatusBadge, ReplayStateBadge } from "../../_components/StatusBadges";
import { Tabs } from "../../_components/Tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  countReplayRequestsCached,
  countActiveReplayRequestsByReasonCached,
  countUnresolvedDeadLettersByReasonCached,
  countUnresolvedDeadLettersCached,
  getDashboardMetricsCached,
  listSourcesCached,
  listReplayRequestsCached,
  type UnresolvedReasonRow,
} from "../../../lib/repositories";
import { requireSession } from "../../../lib/session";
import {
  densifyDailySeries,
  formatBytes,
  formatCompactCount,
  formatCount,
  getDailyDeliveryStatsCached,
  getDailyUsageCached,
  listSourceUsageCached,
  usageEnabled,
  type DailyDeliveryRow,
  type DailyUsageRow,
  type SourceUsageRow,
} from "../../../lib/usage";
import { computeAnalyticsKpis, emptyCaption, unavailableCaption } from "./kpiAnalytics";
import { AnalyticsRecovery } from "./AnalyticsRecovery";
import { OverviewChart } from "./OverviewChart";
import { ReplayReasonButton } from "./ReplayReasonButton";
import { FixWithAiButton } from "./FixWithAiButton";
import { DashboardRangeSelector } from "./DashboardRangeSelector";
import { chartDaysForRange, parseDashboardRange } from "./dashboardRange";
import { KpiLoadingSurface } from "./KpiLoadingSurface";
import { PrimaryChartLoadingSurface } from "./PrimaryChartLoadingSurface";
import { NewSourcePipelineDialog } from "../sources/NewSourcePipelineDialog";
import { FirstRunOnboardingCard } from "../_components/FirstRunOnboardingCard";
import { listActiveDestinationsForPicker } from "../../../lib/first-run-actions";
import { resolveWithin } from "../../../lib/progressive-loading";
import { captureDashboardException } from "../../../lib/sentry-capture";
import { DashboardFreshnessGate } from "./DashboardFreshnessGate";

export const dynamic = "force-dynamic";

// One budget for every analytics read on this page. The KPI tiles and the
// charts share the same cached series; giving them different budgets let the
// chart render full numbers while the tile above it said "analytics catching
// up" in the same viewport (ROL-627).
const ANALYTICS_TIMEOUT_MS = 4_500;
const KPI_METRICS_TIMEOUT_MS = 2_500;

/**
 * Degraded analytics render as "—", so a persistently failing ClickHouse is
 * otherwise indistinguishable from a slow one — in the UI and in telemetry.
 * Log + capture before returning null.
 */
function reportAnalyticsLoadFailure(component: string, err: unknown): null {
  console.error(`[dashboard] ${component} failed`);
  void captureDashboardException(err, { tags: { component } });
  return null;
}

// Cache the complete loaders, including their failure handling. Caching only
// the ClickHouse promise still lets the KPI and chart boundaries catch and
// report the same rejected promise independently.
const loadDailyEvents = cache(async function loadDailyEvents(
  workspaceId: string,
  timezone: string,
  days: number,
): Promise<DailyUsageRow[] | null> {
  if (!usageEnabled()) return null;
  try {
    const rows = await getDailyUsageCached(workspaceId, days, timezone);
    return densifyDailySeries(rows, days, (day) => ({ day, events: 0, bytes: 0 }), timezone);
  } catch (err) {
    return reportAnalyticsLoadFailure("dashboard_daily_events", err);
  }
});

const loadDailyDelivery = cache(async function loadDailyDelivery(
  workspaceId: string,
  timezone: string,
  days: number,
): Promise<DailyDeliveryRow[] | null> {
  if (!usageEnabled()) return null;
  try {
    const rows = await getDailyDeliveryStatsCached(workspaceId, days, timezone);
    return densifyDailySeries(rows, days, (day) => ({
      day,
      success: 0,
      retry: 0,
      dead: 0,
    }), timezone);
  } catch (err) {
    return reportAnalyticsLoadFailure("dashboard_daily_delivery", err);
  }
});

async function loadTopSources(workspaceId: string): Promise<SourceUsageRow[] | null> {
  if (!usageEnabled()) return null;
  try {
    return await listSourceUsageCached(workspaceId);
  } catch (err) {
    return reportAnalyticsLoadFailure("dashboard_top_sources", err);
  }
}

function newSourceFallback() {
  return (
    <Button variant="outline" size="sm" asChild>
      <Link href="/sources" prefetch={false}>
        <Webhook className="mr-1 size-3.5" />
        New source
      </Link>
    </Button>
  );
}

/**
 * The page itself only renders chrome + Suspense boundaries. Each section
 * fetches its own data from the cached helpers; navigations within the
 * 60s revalidate window collapse onto a single PG/CH round-trip across
 * all sections, and slow ClickHouse calls don't gate the fast Postgres
 * sections.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string }>;
}) {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const timezone = session.activeWorkspace.workspace_timezone;
  const usageOn = usageEnabled();
  const range = parseDashboardRange((await searchParams).range);
  const chartDays = chartDaysForRange(range);
  const deltaDays = chartDays * 2;
  const canMutate =
    session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";
  let isEmptyWorkspace = false;
  if (canMutate) {
    try {
      isEmptyWorkspace = (await listSourcesCached(workspaceId)).length === 0;
    } catch {
      // Keep the dashboard available when the sources lookup is temporarily
      // unavailable. Its existing sections will show their recovery states.
    }
  }

  // First run: hand off to the dedicated /setup route. Rendering the flow
  // inline here breaks it — creating a source revalidates the sources tag,
  // this gate flips false, and the flow unmounts mid-setup with the one-shot
  // ingest token still on screen (ROL-457).
  if (isEmptyWorkspace) redirect("/setup");

  return (
    <>
      <PageHeader
        eyebrow="Workspace overview"
        title="Overview"
        description={`Welcome back, ${(session.user.name || session.user.email.split("@")[0])}. Here's what's happening across ${session.activeWorkspace.workspace_name}.`}
        actions={
          <>
            {canMutate ? (
              <Suspense fallback={newSourceFallback()}>
                <NewSourceAction />
              </Suspense>
            ) : (
              newSourceFallback()
            )}
            <DashboardRangeSelector current={range} />
          </>
        }
      />

      <DashboardFreshnessGate>
        <Suspense fallback={<KpiLoadingSurface />}>
          <KpiRow
            workspaceId={workspaceId}
            timezone={timezone}
            chartDays={chartDays}
            deltaDays={deltaDays}
          />
        </Suspense>

        {usageOn ? (
          <section className="mt-6" aria-label={`Volume — last ${chartDays} days`}>
            <Suspense fallback={<PrimaryChartLoadingSurface />}>
              <ChartSection
                workspaceId={workspaceId}
                timezone={timezone}
                chartDays={chartDays}
                deltaDays={deltaDays}
              />
            </Suspense>
          </section>
        ) : (
          <UsageAnalyticsUnavailableSurface />
        )}

        <div className="mt-6 flex flex-col gap-6">
          <Panel title="Top sources this month" link={{ href: "/sources", label: "All sources" }}>
            <Suspense fallback={<ListSkeleton rows={6} />}>
              <TopSourcesSection workspaceId={workspaceId} canMutate={canMutate} />
            </Suspense>
          </Panel>

          <Panel title="Activity" link={{ href: "/deliveries", label: "All deliveries" }}>
            <Suspense fallback={<ListSkeleton rows={6} />}>
              <ActivitySection workspaceId={workspaceId} />
            </Suspense>
          </Panel>
        </div>
      </DashboardFreshnessGate>
    </>
  );
}

// --- Sections ------------------------------------------------------------- //

async function NewSourceAction() {
  const existingDestinations = await listActiveDestinationsForPicker();
  return (
    <NewSourcePipelineDialog
      existingDestinations={existingDestinations}
      trigger={
        <Button variant="outline" size="sm">
          <Webhook className="mr-1 size-3.5" />
          New source
        </Button>
      }
    />
  );
}

async function KpiRow({
  workspaceId,
  timezone,
  chartDays,
  deltaDays,
}: {
  workspaceId: string;
  timezone: string;
  chartDays: number;
  deltaDays: number;
}) {
  // resolveWithin resolves null on timeout, hence the `| null`.
  let metrics: Awaited<ReturnType<typeof getDashboardMetricsCached>> | null;
  let dailyEvents: Awaited<ReturnType<typeof loadDailyEvents>> | null;
  let dailyDelivery: Awaited<ReturnType<typeof loadDailyDelivery>> | null;
  try {
    [metrics, dailyEvents, dailyDelivery] = await Promise.all([
      resolveWithin(getDashboardMetricsCached(workspaceId), KPI_METRICS_TIMEOUT_MS),
      resolveWithin(loadDailyEvents(workspaceId, timezone, deltaDays), ANALYTICS_TIMEOUT_MS),
      resolveWithin(loadDailyDelivery(workspaceId, timezone, deltaDays), ANALYTICS_TIMEOUT_MS),
    ]);
  } catch {
    return <KpiRowUnavailable />;
  }
  if (!metrics) return <KpiRowUnavailable />;
  // "Failed deliveries" is the same count that the old
  // `countUnresolvedDeadLettersCached` was fetching separately — same
  // SQL, same cache tag. Read it from the metrics array we already have
  // instead of paying for a second query.

  const usageOn = usageEnabled();
  const kpis = computeAnalyticsKpis({ dailyEvents, dailyDelivery, chartDays, usageOn });
  const offlineSub = unavailableCaption(usageOn);

  const metricsByLabel = Object.fromEntries(
    metrics.map((m) => [m.label, Number(m.value)]),
  ) as Record<string, number>;
  const unresolvedTotal = metricsByLabel["Failed deliveries"] ?? 0;
  const activeSources = metricsByLabel["Active sources"] ?? 0;
  const totalSources = metricsByLabel["Sources"] ?? 0;
  const routes = metricsByLabel["Routes"] ?? 0;
  const pausedSources = Math.max(0, totalSources - activeSources);
  const sourcesSub = pausedSources > 0
    ? `${pausedSources} paused · ${routes} ${routes === 1 ? "route" : "routes"}`
    : `${routes} ${routes === 1 ? "route" : "routes"}`;

  const eventsSub = kpis.events.available
    ? emptyCaption(kpis.events.recent, kpis.events.delta, "no events yet")
    : offlineSub;
  const deliveriesSub = kpis.deliveries.available
    ? emptyCaption(kpis.deliveries.recent, kpis.deliveries.delta, "no deliveries yet")
    : offlineSub;
  const successRateSub = !kpis.successRate.available
    ? offlineSub
    : kpis.successRate.ratePct === null
      ? "no deliveries yet"
      : kpis.successRate.delta === null
        ? "no prior data"
        : undefined;
  // unresolvedTotal comes from Postgres and stays authoritative even when
  // the ClickHouse series is unavailable — only the per-window outcome
  // count depends on analytics, so drop it rather than claiming "0".
  const deadSub = unresolvedTotal > 0
    ? kpis.dead.available
      ? `${formatCount(kpis.dead.recent)} logged outcome${kpis.dead.recent === 1 ? "" : "s"} · needs replay`
      : "needs replay"
    : kpis.dead.available
      ? emptyCaption(kpis.dead.recent, kpis.dead.delta, "no unresolved dead letters")
      : "no unresolved dead letters";

  return (
    <section
      data-dashboard-primary-metrics="ready"
      data-dashboard-kpi-analytics={kpis.degraded ? "degraded" : "ready"}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-label={`Last ${chartDays} days at a glance`}
    >
      {kpis.degraded ? <AnalyticsRecovery /> : null}
      <KpiCard
        label="Events ingested"
        value={kpis.events.available ? formatCount(kpis.events.recent) : "—"}
        compactValue={kpis.events.available ? formatCompactCount(kpis.events.recent) : "—"}
        deltaPct={kpis.events.available ? kpis.events.delta : null}
        href="/usage"
        {...(eventsSub ? { sub: eventsSub } : {})}
      />
      <KpiCard
        label="Deliveries"
        value={kpis.deliveries.available ? formatCount(kpis.deliveries.recent) : "—"}
        compactValue={kpis.deliveries.available ? formatCompactCount(kpis.deliveries.recent) : "—"}
        deltaPct={kpis.deliveries.available ? kpis.deliveries.delta : null}
        href="/deliveries"
        {...(deliveriesSub ? { sub: deliveriesSub } : {})}
      />
      <KpiCard
        label="Success rate"
        value={kpis.successRate.ratePct === null ? "—" : `${kpis.successRate.ratePct.toFixed(1)}%`}
        deltaPct={kpis.successRate.delta}
        href="/deliveries"
        {...(successRateSub ? { sub: successRateSub } : {})}
      />
      <KpiCard
        label="Unresolved failures"
        value={formatCount(unresolvedTotal)}
        compactValue={formatCompactCount(unresolvedTotal)}
        deltaPct={kpis.dead.available ? kpis.dead.delta : null}
        inverse
        href="/deliveries"
        {...(deadSub ? { sub: deadSub } : {})}
      />
      <KpiCard
        label="Active sources"
        value={String(activeSources)}
        sub={sourcesSub}
        deltaPct={null}
        href="/sources"
      />
    </section>
  );
}

async function ChartSection({
  workspaceId,
  timezone,
  chartDays,
  deltaDays,
}: {
  workspaceId: string;
  timezone: string;
  chartDays: number;
  deltaDays: number;
}) {
  // resolveWithin resolves null on timeout, hence the `| null`.
  let dailyEvents: Awaited<ReturnType<typeof loadDailyEvents>> | null;
  let dailyDelivery: Awaited<ReturnType<typeof loadDailyDelivery>> | null;
  let unresolvedTotal: Awaited<ReturnType<typeof countUnresolvedDeadLettersCached>> | null;
  try {
    [dailyEvents, dailyDelivery, unresolvedTotal] = await Promise.all([
      resolveWithin(loadDailyEvents(workspaceId, timezone, deltaDays), ANALYTICS_TIMEOUT_MS),
      resolveWithin(loadDailyDelivery(workspaceId, timezone, deltaDays), ANALYTICS_TIMEOUT_MS),
      resolveWithin(countUnresolvedDeadLettersCached(workspaceId), ANALYTICS_TIMEOUT_MS),
    ]);
  } catch {
    return <ChartLoadError />;
  }

  if (!dailyEvents && !dailyDelivery) return <ChartLoadError />;

  return (
    <OverviewChart
      events={dailyEvents?.slice(-chartDays) ?? null}
      delivery={dailyDelivery?.slice(-chartDays) ?? null}
      unresolvedFailures={unresolvedTotal ?? 0}
      chartDays={chartDays}
    />
  );
}

function KpiRowUnavailable() {
  return (
    <section
      data-dashboard-primary-metrics="degraded"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-label="Primary metrics temporarily unavailable"
    >
      <KpiCard
        label="Events ingested"
        value="—"
        sub="temporarily unavailable"
        deltaPct={null}
        href="/usage"
      />
      <KpiCard
        label="Deliveries"
        value="—"
        sub="temporarily unavailable"
        deltaPct={null}
        href="/deliveries"
      />
      <KpiCard
        label="Success rate"
        value="—"
        sub="temporarily unavailable"
        deltaPct={null}
        href="/deliveries"
      />
      <KpiCard
        label="Unresolved failures"
        value="—"
        sub="temporarily unavailable"
        deltaPct={null}
        inverse
        href="/deliveries"
      />
      <KpiCard
        label="Active sources"
        value="—"
        sub="temporarily unavailable"
        deltaPct={null}
        href="/sources"
      />
    </section>
  );
}

async function TopSourcesSection({
  workspaceId,
  canMutate,
}: {
  workspaceId: string;
  canMutate: boolean;
}) {
  let topSources: Awaited<ReturnType<typeof loadTopSources>>;
  let sources: Awaited<ReturnType<typeof listSourcesCached>>;
  try {
    [topSources, sources] = await Promise.all([
      loadTopSources(workspaceId),
      listSourcesCached(workspaceId),
    ]);
  } catch {
    return <PanelLoadError label="Top sources" />;
  }

  const sourceNamesById = new Map(sources.map((s) => [s.id, s.name]));
  const topSourcesEnriched = (topSources ?? []).map((row) => ({
    ...row,
    source_name: sourceNamesById.get(row.source_id) ?? null,
  }));

  if (topSourcesEnriched.length > 0) {
    return (
      <Tabs
        ariaLabel="Top sources view"
        items={[
          {
            key: "events",
            label: "By events",
            content: <TopSourcesTable rows={topSourcesEnriched} field="events" />,
          },
          {
            key: "bytes",
            label: "By bytes",
            content: <TopSourcesTable rows={topSourcesEnriched} field="bytes" />,
          },
        ]}
      />
    );
  }

  const sourcesPreview = sources.slice(0, 8);
  if (sourcesPreview.length) {
    return (
      <ul className="flex flex-col">
        {sourcesPreview.map((source) => (
          <li key={source.id} className="border-b border-border last:border-0">
            <Link
              href={`/sources/${source.id}`}
              className="flex items-center justify-between gap-3 py-2.5 transition-colors hover:bg-accent/30"
            >
              <div className="flex min-w-0 flex-col">
                <strong className="truncate text-sm font-medium text-foreground">{source.name}</strong>
                <small className="truncate font-mono text-[11px] text-muted-foreground">{source.id}</small>
              </div>
              <EntityStatusBadge status={source.status} className="capitalize" />
            </Link>
          </li>
        ))}
      </ul>
    );
  }

  // Zero configured sources. Owners/admins get the guided first-run card
  // (which opens the source+pipeline wizard in place — previously this CTA
  // just navigated to /sources, dropping the user one click short). Viewers
  // can't create, so they keep a plain read-only empty state.
  if (canMutate) {
    const dests = await listActiveDestinationsForPicker();
    return (
      <FirstRunOnboardingCard
        trigger={
          <NewSourcePipelineDialog
            existingDestinations={dests}
            autoOpenOnCreateParam={false}
            trigger={
              <Button size="sm">
                <Webhook className="mr-1 size-3.5" />
                Set up your first source
              </Button>
            }
          />
        }
      />
    );
  }
  return (
    <EmptyState
      title="No sources yet"
      body="A source is the inbound webhook we receive events from. An owner can create the first one to start routing."
      glyph="↘"
    />
  );
}

async function ActivitySection({ workspaceId }: { workspaceId: string }) {
  let reasonBreakdown: Awaited<ReturnType<typeof countUnresolvedDeadLettersByReasonCached>>;
  let activeReplayRows: Awaited<ReturnType<typeof countActiveReplayRequestsByReasonCached>>;
  let replays: Awaited<ReturnType<typeof listReplayRequestsCached>>;
  let replayTotal: Awaited<ReturnType<typeof countReplayRequestsCached>>;
  try {
    [
      reasonBreakdown,
      activeReplayRows,
      replays,
      replayTotal,
    ] = await Promise.all([
      countUnresolvedDeadLettersByReasonCached(workspaceId),
      countActiveReplayRequestsByReasonCached(workspaceId).catch(() => []),
      listReplayRequestsCached(workspaceId),
      countReplayRequestsCached(workspaceId),
    ]);
  } catch {
    return <PanelLoadError label="Activity" />;
  }
  const reasonsWithReplayState = reasonBreakdown.map((row) => {
    const pending = activeReplayRows
      .filter((active) => active.reason === row.reason && active.state === "pending")
      .reduce((sum, active) => sum + active.count, 0);
    const inProgress = activeReplayRows
      .filter((active) => active.reason === row.reason && active.state === "in_progress")
      .reduce((sum, active) => sum + active.count, 0);
    return {
      ...row,
      active_replay_count: pending + inProgress,
      active_replay_pending_count: pending,
      active_replay_in_progress_count: inProgress,
    };
  });
  const unresolvedTotal = reasonsWithReplayState.reduce((sum, row) => sum + row.count, 0);

  if (unresolvedTotal === 0 && replayTotal === 0) {
    return (
      <EmptyState
        title="All deliveries healthy"
        body="No failed deliveries. Anything that fails will land here with a one-line fix."
        glyph="✓"
      />
    );
  }

  return (
      <FailureBacklog
        unresolvedTotal={unresolvedTotal}
        reasons={reasonsWithReplayState}
      replayTotal={replayTotal}
      recentReplays={replays.slice(0, 3)}
    />
  );
}

function PanelLoadError({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
      {label} is temporarily unavailable. Refresh in a moment.
    </div>
  );
}

function ChartLoadError() {
  return (
    <div
      data-dashboard-primary-chart="degraded"
      className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
    >
      <span>Delivery chart is temporarily unavailable. Refresh in a moment.</span>
      <Link
        href="/deliveries"
        prefetch={false}
        data-dashboard-primary-chart-action="degraded"
        className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
      >
        Open deliveries
      </Link>
    </div>
  );
}

function UsageAnalyticsUnavailableSurface() {
  return (
    <section
      data-dashboard-primary-chart="degraded"
      className="mt-6 rounded-xl border border-border bg-card p-6"
      aria-label="Primary usage analytics unavailable"
    >
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">Volume</p>
          <strong className="text-lg font-semibold text-foreground">Usage analytics unavailable</strong>
          <small className="text-xs text-muted-foreground">
            Configure ClickHouse to populate event volume and delivery outcome charts.
          </small>
        </div>
        <Link
          href="/deliveries"
          prefetch={false}
          data-dashboard-primary-chart-action="degraded"
          className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          Open deliveries
        </Link>
      </div>
      <div className="overflow-hidden rounded-lg border border-border/70">
        <div className="grid grid-cols-[1fr_auto] border-b border-border bg-muted/30 px-3 py-2 text-[11px] font-medium uppercase text-muted-foreground">
          <span>Primary stream</span>
          <span>Action</span>
        </div>
        {[
          { label: "Event volume", href: "/usage", action: "Open usage" },
          { label: "Delivery outcomes", href: "/deliveries", action: "Open deliveries" },
          { label: "Source health", href: "/sources", action: "Open sources" },
        ].map((row) => (
          <Link
            key={row.label}
            href={row.href}
            prefetch={false}
            data-dashboard-primary-chart-action="degraded"
            className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border px-3 py-3 text-sm transition-colors last:border-0 hover:bg-accent/50"
          >
            <span className="truncate text-foreground">{row.label}</span>
            <span className="text-xs text-muted-foreground">{row.action}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function FailureBacklog({
  unresolvedTotal,
  reasons,
  replayTotal,
  recentReplays,
}: {
  unresolvedTotal: number;
  reasons: UnresolvedReasonRow[];
  replayTotal: number;
  recentReplays: ReplayPreviewRow[];
}) {
  const topReasons = reasons.slice(0, 4);
  const otherCount = reasons.slice(4).reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="flex flex-col gap-4">
      {unresolvedTotal > 0 ? (
        <>
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold tabular-nums text-foreground">
              {formatCount(unresolvedTotal)}
            </span>
            <span className="text-sm text-muted-foreground">
              unresolved {unresolvedTotal === 1 ? "failure" : "failures"} to replay
            </span>
          </div>

          {topReasons.length > 0 ? (
            <ul className="flex flex-col">
              {topReasons.map((row) => (
                <li
                  key={row.reason}
                  className="flex flex-col gap-3 border-b border-border py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <Badge variant="destructive" className="shrink-0">
                        {formatCount(row.count)}
                      </Badge>
                      <strong
                        className="truncate font-mono text-sm font-medium text-foreground"
                        title={row.reason}
                      >
                        {row.reason}
                      </strong>
                    </div>
                    <small className="block text-xs text-muted-foreground">
                      {fixForFailureType(row.reason)}
                    </small>
                    {row.active_replay_count > 0 ? (
                      <small className="mt-1 block text-xs text-emerald-700 dark:text-emerald-400">
                        {formatCount(row.active_replay_count)} replay
                        {row.active_replay_count === 1 ? "" : "s"} queued or running
                        {row.active_replay_in_progress_count > 0
                          ? ` · ${formatCount(row.active_replay_in_progress_count)} in progress`
                          : ""}
                        {row.active_replay_pending_count > 0
                          ? ` · ${formatCount(row.active_replay_pending_count)} pending`
                          : ""}
                      </small>
                    ) : null}
                  </div>
                  <ReasonActions row={row} />
                </li>
              ))}
              {otherCount > 0 ? (
                <li className="flex items-center justify-between gap-3 py-2 text-xs text-muted-foreground">
                  <span>Other reasons</span>
                  <span className="font-mono">{formatCount(otherCount)}</span>
                </li>
              ) : null}
            </ul>
          ) : null}
        </>
      ) : null}

      {replayTotal > 0 ? (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">
            Recent replays · {formatCount(replayTotal)} in the last 30 days
          </summary>
          <ul className="mt-2 flex flex-col gap-1.5 border-l-2 border-border pl-3">
            {recentReplays.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-2">
                <code className="truncate font-mono text-[11px] text-foreground">
                  {row.event_id}
                </code>
                <ReplayStateBadge
                  state={row.state}
                  className="shrink-0 capitalize text-[10px]"
                />
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Some failure reasons can't be fixed by replay alone — replaying a
 * route_processing_failed event 1000 times still leaves the broken
 * DSL broken. Classify the reason and render the right primary CTA:
 *
 *   - `ai_fix`     → Data Contract AI patch flow (route DSL bugs).
 *                    Deep-link to /deliveries/<sample>/investigate.
 *   - `source_fix` → fix on the source page (signature secrets).
 *   - `dest_fix`   → fix on the destinations page (auth, URL).
 *   - `check_first`→ destination state may need confirming, but
 *                    replay is also reasonable (max_retries_exceeded,
 *                    unreachable). Show both buttons.
 *   - `replay`     → safe to replay as-is (duplicates / idempotency).
 */
interface ReasonGuidance {
  kind: "ai_fix" | "source_fix" | "dest_fix" | "replay";
  href?: string;
  label?: string;
}

function classifyReason(row: UnresolvedReasonRow): ReasonGuidance {
  const r = row.reason.toLowerCase();
  // Real DSL failures — these the AI can actually rewrite. Granular
  // reasons come from RouteEngineError.reason ("transform_*", "filter_*")
  // and the fallback "declarative_engine_error" wrapper.
  if (
    r === "declarative_engine_error" ||
    r.startsWith("transform_") ||
    r.startsWith("filter_")
  ) {
    return {
      kind: "ai_fix",
      href: `/deliveries/${row.sample_dead_letter_id}/investigate`,
      label: "Fix with AI",
    };
  }
  // router_processing_failed is the outer catch in router-edge — it
  // fires before any DSL evaluation runs, so the AI rewrite path is
  // wrong. Send operators to the underlying error message instead.
  if (r === "router_processing_failed" || r === "internal_routes_500") {
    return {
      kind: "dest_fix",
      href: `/deliveries/${row.sample_dead_letter_id}/investigate`,
      label: "Open error",
    };
  }
  if (r.startsWith("signature_")) {
    return {
      kind: "source_fix",
      href: `/sources/${row.sample_source_id}`,
      label: "Fix source secret",
    };
  }
  const status = r.match(/^http\s+(\d{3})$/)?.[1];
  if (status === "401" || status === "403") {
    return { kind: "dest_fix", href: "/destinations", label: "Fix credentials" };
  }
  if (status === "404") {
    return { kind: "dest_fix", href: "/destinations", label: "Fix destination URL" };
  }
  // For destination-side flakiness, replay is the right primary
  // action (the destination may already be healthy again), but we
  // want to point at the latest failure's investigate page — that's
  // where the response body + AI "Why?" actually explain what went
  // wrong, vs the destinations list which is just a roster.
  if (
    r === "destination_unreachable" ||
    r === "connection_refused" ||
    r === "max_retries_exceeded"
  ) {
    return {
      kind: "replay",
      href: `/deliveries/${row.sample_dead_letter_id}/investigate`,
      label: "See why →",
    };
  }
  return { kind: "replay" };
}

function ReasonActions({ row }: { row: UnresolvedReasonRow }) {
  const guidance = classifyReason(row);

  // ai_fix: one-click — the button runs the whole explain → approve →
  // replay flow server-side and reports back inline. No redirect.
  if (guidance.kind === "ai_fix") {
    return <FixWithAiButton reason={row.reason} count={row.count} />;
  }

  // source_fix / dest_fix: AI can't fix these (the broken thing is a
  // secret / a URL / a credential that lives on the platform side),
  // so the primary CTA is a deep-link to the config page.
  if (guidance.kind === "source_fix" || guidance.kind === "dest_fix") {
    const hasActiveReplay = row.active_replay_count > 0;
    return (
      <div className="flex shrink-0 flex-col items-end gap-1">
        <Button asChild size="sm" variant="default">
          <Link href={guidance.href!} prefetch={false}>
            <Wrench className="mr-1 size-3.5" />
            {guidance.label}
          </Link>
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {hasActiveReplay
            ? `${formatCount(row.active_replay_count)} replay${row.active_replay_count === 1 ? "" : "s"} already queued`
            : "Replay enabled after fix"}
        </span>
      </div>
    );
  }

  // Replay-primary path: duplicates / idempotency conflicts (safe to
  // replay) and destination flakiness (replay may resolve transient
  // cases; secondary link points at the latest failure's investigate
  // page so the operator can see the actual response if it doesn't).
  const inspectHref =
    guidance.href ??
    `/deliveries?status=failed&q=${encodeURIComponent(row.reason)}`;
  const inspectLabel = guidance.label ?? "Inspect →";
  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <ReplayReasonButton
        reason={row.reason}
        count={row.count}
        activeReplayCount={row.active_replay_count}
      />
      <Link
        href={inspectHref}
        className="text-xs text-muted-foreground hover:text-foreground"
      >
        {inspectLabel}
      </Link>
    </div>
  );
}

// --- Skeletons ------------------------------------------------------------ //

function ListSkeleton({ rows }: { rows: number }) {
  return (
    <ul className="flex flex-col" aria-busy="true">
      {Array.from({ length: rows }).map((_, i) => (
        <li key={i} className="flex items-center justify-between gap-3 border-b border-border py-2.5 last:border-0">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2 w-48" />
          </div>
          <Skeleton className="h-5 w-16" />
        </li>
      ))}
    </ul>
  );
}

// --- Shared bits ---------------------------------------------------------- //

function Panel({
  title,
  link,
  children,
}: {
  title: string;
  link?: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        {link ? (
          <Link
            href={link.href}
            prefetch={false}
            className="inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {link.label}
            <ArrowRight className="size-3" />
          </Link>
        ) : null}
      </div>
      {children}
    </section>
  );
}

type EnrichedSourceUsage = SourceUsageRow & { source_name: string | null };

function TopSourcesTable({ rows, field }: { rows: EnrichedSourceUsage[]; field: "events" | "bytes" }) {
  const sorted = [...rows].sort((a, b) =>
    field === "events" ? b.events - a.events : b.bytes - a.bytes,
  );
  const max = Math.max(1, sorted[0]?.[field] ?? 1);
  return (
    <ul className="flex flex-col">
      {sorted.slice(0, 8).map((row) => {
        const value = row[field];
        const pct = Math.max(2, Math.round((value / max) * 100));
        return (
          <li key={row.source_id} className="border-b border-border last:border-0">
            <Link
              href={`/sources/${row.source_id}`}
              className="flex items-center justify-between gap-3 py-2 transition-colors hover:bg-accent/30"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <strong className="truncate text-sm font-medium text-foreground">
                  {row.source_name ?? row.source_id}
                </strong>
                <span className="relative h-1 w-full overflow-hidden rounded-sm bg-muted" aria-hidden="true">
                  <span className="absolute inset-y-0 left-0 bg-primary/70" style={{ width: `${pct}%` }} />
                </span>
              </div>
              <small className="font-mono text-xs text-muted-foreground">
                {field === "events" ? formatCount(value) : formatBytes(value)}
              </small>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function fixForFailureType(errorType: string): string {
  const normalized = errorType.toLowerCase();
  // dead_letters.reason slugs (snake_case enums produced by the worker
  // pipeline) — handle these first because their wording is specific.
  if (normalized === "max_retries_exceeded") {
    return "Destination kept rejecting after every retry. Fix the destination, then replay.";
  }
  if (normalized === "declarative_engine_error") {
    return "The route's transform or filter blew up. Open the event to see the error, fix the DSL, then replay.";
  }
  if (normalized === "router_processing_failed" || normalized === "internal_routes_500") {
    // Catch-all from router-edge's outer try/catch. The cause lives in the
    // `message` column — route lookup, native dispatch 503, queue overload,
    // R2 read failure. Steer operators to the actual error rather than
    // assuming a DSL bug.
    return "Router pipeline threw before fan-out. Open the event for the underlying error (route lookup, destination 503, or queue backpressure), then replay.";
  }
  if (normalized === "destination_unreachable" || normalized === "connection_refused") {
    return "Destination didn't accept the connection. Confirm it's up and reachable, then replay.";
  }
  if (normalized === "signature_invalid" || normalized === "signature_mismatch") {
    return "Source signature failed verification. Re-check the signing secret on the source.";
  }
  const statusMatch = normalized.match(/^http\s+(\d{3})$/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 401 || status === 403) return "Check destination credentials, tokens, and permission scopes, then replay.";
    if (status === 404) return "Check the destination URL or route target; update it before replaying.";
    if (status === 408 || status === 429) return "Reduce send rate or raise destination limits, then replay the unresolved backlog.";
    if (status >= 500) return "Destination returned a server error. Confirm it is healthy, then replay.";
    if (status >= 400) return "Destination rejected the request. Inspect the response body and adjust mapping or endpoint config.";
  }
  if (normalized.includes("timeout") || normalized.includes("network") || normalized.includes("fetch")) {
    return "Verify destination connectivity and timeout limits, then replay.";
  }
  if (normalized.includes("credential") || normalized.includes("auth") || normalized.includes("permission")) {
    return "Rotate or repair destination credentials, then replay.";
  }
  if (normalized.includes("rate") || normalized.includes("limit")) {
    return "Tune route throughput or destination rate limits, then replay.";
  }
  if (normalized.includes("already delivered") || normalized.includes("duplicate")) {
    return "Likely an idempotency conflict. Confirm destination state before replaying.";
  }
  return "Open Deliveries for response details, fix the destination or route config, then replay.";
}

type ReplayPreviewRow = Awaited<ReturnType<typeof listReplayRequestsCached>>[number];
