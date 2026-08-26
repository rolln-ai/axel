import { Suspense } from "react";
import { notFound } from "next/navigation";
import { db } from "../../../../../lib/db";
import { requireSession } from "../../../../../lib/session";
import { getDestinationSummary } from "../../../../../lib/destination-inspect";
import { hasClickhouseUrl } from "../../../../../lib/clickhouse";
import {
  getDailyDestinationDeliveryStats,
  getDestinationEdaSeries,
  getDestinationLatencyPercentiles,
  getDestinationResponseCodeDistribution,
  getDestinationRouteHealth,
} from "../../../../../lib/destination-metrics";
import { DeliveryTimeSeriesChart } from "../DeliveryTimeSeriesChart";
import { LatencyProfile } from "../LatencyProfile";
import { ResponseCodeBreakdown } from "../ResponseCodeBreakdown";
import { RouteHealthTable } from "../RouteHealthTable";
import { EdaPanel } from "../EdaPanel";
import { Section } from "../../../../_components/Section";
import { Skeleton } from "@/components/ui/skeleton";

export const dynamic = "force-dynamic";

const TIME_SERIES_DAYS = 14;
const EDA_DEFAULT_DIMENSION = "hour" as const;
const EDA_DEFAULT_WINDOW_HOURS = 24 * 7;

interface RouteAttachmentRow {
  route_id: string;
  source_id: string;
  source_name: string;
  status: "active" | "disabled" | "errored";
}

export default async function DestinationHealthPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const timezone = session.activeWorkspace.workspace_timezone;

  // Kick off destination + route-attachment queries in parallel — attachments
  // only need the id from the URL and the workspaceId, so there's no point
  // gating them on the destination fetch resolving first.
  const [destination, attachmentsResult] = await Promise.all([
    getDestinationSummary(id, workspaceId),
    db().query<RouteAttachmentRow>(
      `SELECT r.id AS route_id, r.source_id, s.name AS source_name, r.status
         FROM route_destinations rd
         JOIN routes r ON r.id = rd.route_id
         JOIN sources s ON s.id = r.source_id
        WHERE rd.destination_id = $1 AND r.workspace_id = $2
        ORDER BY r.created_at DESC`,
      [id, workspaceId],
    ),
  ]);
  if (!destination) notFound();

  if (!hasClickhouseUrl()) {
    return (
      <Section title="Delivery analytics" pill="analytics not configured">
        <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
          <small className="text-sm text-muted-foreground">
            Set <code className="font-mono">CLICKHOUSE_URL</code> to enable delivery health graphs and EDA for this destination.
          </small>
        </div>
      </Section>
    );
  }

  return (
    <Suspense fallback={<HealthSkeleton />}>
      <HealthBody
        destinationId={destination.id}
        workspaceId={workspaceId}
        timezone={timezone}
        attachments={attachmentsResult.rows}
      />
    </Suspense>
  );
}

async function HealthBody({
  destinationId,
  workspaceId,
  timezone,
  attachments,
}: {
  destinationId: string;
  workspaceId: string;
  timezone: string;
  attachments: RouteAttachmentRow[];
}) {
  const [daily, latency, responseCodes, routeHealth, edaSeries] = await Promise.all([
    getDailyDestinationDeliveryStats(workspaceId, destinationId, TIME_SERIES_DAYS, { timezone }),
    getDestinationLatencyPercentiles(workspaceId, destinationId, 24),
    getDestinationResponseCodeDistribution(workspaceId, destinationId, 24),
    getDestinationRouteHealth(workspaceId, destinationId, 24),
    getDestinationEdaSeries(
      workspaceId,
      destinationId,
      EDA_DEFAULT_DIMENSION,
      EDA_DEFAULT_WINDOW_HOURS,
      { timezone },
    ),
  ]);

  return (
    <>
      <Section title="Daily delivery outcomes" pill={`${TIME_SERIES_DAYS}-day stacked bars`}>
        <DeliveryTimeSeriesChart rows={daily} days={TIME_SERIES_DAYS} timezone={timezone} />
      </Section>

      <Section title="Latency profile" pill="excludes failed terminal attempts · last 24h">
        <LatencyProfile percentiles={latency} daily={daily} days={TIME_SERIES_DAYS} timezone={timezone} />
      </Section>

      <Section title="Failures by error type" pill="last 24h · top 10 buckets">
        <ResponseCodeBreakdown buckets={responseCodes} />
      </Section>

      {attachments.length > 0 ? (
        <Section
          title="Routes using this destination"
          pill={`${attachments.length} route${attachments.length === 1 ? "" : "s"} · 24h health`}
        >
          <RouteHealthTable attachments={attachments} health={routeHealth} />
        </Section>
      ) : null}

      <Section title="Explore delivery data" pill="interactive · group · pivot · drill">
        <EdaPanel
          destinationId={destinationId}
          initialRows={edaSeries}
          initialDimension={EDA_DEFAULT_DIMENSION}
          initialWindowHours={EDA_DEFAULT_WINDOW_HOURS}
        />
      </Section>
    </>
  );
}

function HealthSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-72 w-full rounded-lg" />
      <Skeleton className="h-60 w-full rounded-lg" />
      <Skeleton className="h-60 w-full rounded-lg" />
    </div>
  );
}
