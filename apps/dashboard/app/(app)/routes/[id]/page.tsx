import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Wrench } from "lucide-react";
import { EmptyState } from "../../../EmptyState";
import { LocalTime } from "../../../_components/LocalTime";
import { Section } from "../../../_components/Section";
import { DeliveryStatusBadge, EntityStatusBadge } from "../../../_components/StatusBadges";
import { RouteActions } from "../RouteActions";
import { db } from "../../../../lib/db";
import { requireSession } from "../../../../lib/session";
import {
  formatBytes,
  getRouteDeliveryStats24h,
  listRecentRouteEvents,
  usageEnabled,
  type RouteEventRow,
} from "../../../../lib/usage";
import { FocusLegend, type FocusDestination, type FocusSource } from "./RouteFocusCanvas";
import { RoutePipelineCanvas } from "./RoutePipelineCanvas";
import { EditRouteDestinationsForm } from "./EditRouteDestinationsForm";
import { RenameRouteForm } from "./RenameRouteForm";
import { TestRoutePanel } from "./TestRoutePanel";
import { BackfillRouteForm } from "./BackfillRouteForm";
import { CopyButton } from "../../_components/CopyButton";
import { getActiveBackfillJob } from "../../../../lib/backfill-jobs";
import { resolveWithin } from "../../../../lib/progressive-loading";
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

interface RouteRow {
  id: string;
  name: string | null;
  source_id: string;
  source_name: string;
  source_status: "active" | "disabled";
  status: "active" | "disabled" | "errored";
  filter_expression: string | null;
  transform_script: string | null;
  pipeline_graph: string | null;
  updated_at: string;
  created_at: string;
}

interface DestinationRow {
  id: string;
  name: string;
  type: string;
  status: "active" | "disabled";
}

type RouteTab = "overview" | "destinations" | "test" | "backfill" | "events";

function normalizeRouteTab(raw: string | undefined): RouteTab {
  if (raw === "destinations" || raw === "test" || raw === "backfill" || raw === "events") return raw;
  return "overview";
}

export default async function RouteDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; repair?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const tab = normalizeRouteTab(query.tab);
  const repairingFieldType = query.repair === "field-type";
  const repairingFieldShape = query.repair === "field-shape";
  const repairingData = repairingFieldType || repairingFieldShape;
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";
  const canDelete = session.activeWorkspace.role === "owner";
  const canUseAnalytics = usageEnabled();

  // Keep route/destination rows on the critical path, but make analytical
  // ClickHouse reads tab-scoped. A slow ClickHouse query should not delay the
  // overview canvas: missing stats only means neutral edge coloring.
  const routeStatsPromise =
    canUseAnalytics && tab === "overview"
      ? resolveWithin(
          getRouteDeliveryStats24h(workspaceId).catch((): { error: string } => ({
            error: "Route analytics are temporarily unavailable.",
          })),
          1_200,
        )
      : Promise.resolve(null);
  const recentEventsPromise =
    canUseAnalytics && tab === "events"
      ? listRecentRouteEvents(workspaceId, id, 30).catch((): { error: string } => ({
          error: "Recent route events are temporarily unavailable.",
        }))
      : Promise.resolve(null);

  const [routeResult, destResult, allDestinationsResult, activeBackfillJob, statsOutcome, recentEventsOutcome] = await Promise.all([
    db().query<RouteRow>(
      `SELECT r.id, r.name, r.source_id, s.name AS source_name, s.status AS source_status,
              r.status, r.filter_expression, r.transform_script,
              r.pipeline_graph::text AS pipeline_graph,
              r.updated_at::text AS updated_at,
              r.created_at::text
         FROM routes r
         JOIN sources s ON s.id = r.source_id
        WHERE r.id = $1 AND r.workspace_id = $2
        LIMIT 1`,
      [id, workspaceId],
    ),
    db().query<DestinationRow & { binding: unknown }>(
      `SELECT d.id,
              COALESCE(d.name, d.id) AS name,
              d.type,
              d.status,
              CASE
                WHEN d.type = 'bigquery'
                  AND rd.binding IS NULL
                  AND NULLIF(d.config->>'table', '') IS NOT NULL
                  THEN jsonb_strip_nulls(jsonb_build_object(
                    'table', d.config->>'table',
                    'mode', 'json_column',
                    'payload_column', NULLIF(d.config->>'payload_column', '')
                  ))
                ELSE rd.binding
              END AS binding
         FROM route_destinations rd
         JOIN destinations d ON d.id = rd.destination_id
        WHERE rd.route_id = $1
        ORDER BY d.name`,
      [id],
    ),
    canMutate && tab === "destinations"
      ? db().query<DestinationRow>(
          `SELECT id, COALESCE(name, id) AS name, type, status
             FROM destinations
            WHERE workspace_id = $1
            ORDER BY status = 'disabled', name`,
          [workspaceId],
        )
      : Promise.resolve({ rows: [] as DestinationRow[] }),
    canMutate && tab === "backfill" ? getActiveBackfillJob(workspaceId, id) : Promise.resolve(null),
    routeStatsPromise,
    recentEventsPromise,
  ]);

  const route = routeResult.rows[0];
  if (!route) notFound();

  let stats: Awaited<ReturnType<typeof getRouteDeliveryStats24h>> = [];
  let recentEvents: RouteEventRow[] = [];
  let chError: string | null = null;
  if (statsOutcome) {
    if (Array.isArray(statsOutcome)) stats = statsOutcome;
    else chError = statsOutcome.error;
  }
  if (recentEventsOutcome) {
    if (Array.isArray(recentEventsOutcome)) recentEvents = recentEventsOutcome;
    else chError = recentEventsOutcome.error;
  }
  const statByDest = new Map(
    stats.filter((s) => s.route_id === id).map((s) => [s.destination_id, s]),
  );

  const focusSource: FocusSource = {
    id: route.source_id,
    name: route.source_name,
    status: route.source_status,
  };
  const focusDestinations: FocusDestination[] = destResult.rows.map((d) => {
    const s = statByDest.get(d.id);
    return {
      id: d.id,
      name: d.name,
      type: d.type,
      status: d.status,
      success: s?.success ?? 0,
      retry: s?.retry ?? 0,
      dead: s?.dead ?? 0,
    };
  });
  const bindingsByDestinationId: Record<string, Record<string, unknown>> = Object.fromEntries(
    destResult.rows
      .filter((r) => r.binding !== null)
      .map((r) => [r.id, r.binding as Record<string, unknown>]),
  );
  return (
    <>
      <div className="mb-6 flex items-end justify-between gap-4 border-b border-border pb-5">
        <div className="flex flex-col gap-1">
          <Link
            href="/routes"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3" />
            All pipelines
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
            {route.name ??
              `${route.source_name} → ${
                focusDestinations.map((d) => d.name).join(", ") || "(no destinations)"
              }`}
          </h1>
          <p className="text-sm text-muted-foreground">
            {route.source_name} →{" "}
            {focusDestinations.map((d) => d.name).join(", ") || "(no destinations)"}
          </p>
          <small className="font-mono text-xs text-muted-foreground">{route.id}</small>
        </div>
        <EntityStatusBadge status={route.status} className="capitalize" />
      </div>

      {tab === "overview" ? (
        <>
          {repairingData ? (
            <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">
              <p className="flex items-center gap-1.5 font-semibold text-foreground">
                <Wrench className="size-3.5" /> Fix the field {repairingFieldShape ? "shape" : "type"} before replaying
              </p>
              {repairingFieldShape ? (
                <p className="mt-1 text-muted-foreground">
                  Select the BigQuery destination and run its compatibility check. Use a compatible table with a REPEATED field to preserve the array,
                  or edit the pipeline and add <strong className="text-foreground">Collapse arrays to text</strong> when one STRING value is intentional.
                  Load a sample to preview the result before saving.
                </p>
              ) : (
                <p className="mt-1 text-muted-foreground">
                  Edit the pipeline, add a transform, and choose <strong className="text-foreground">Convert field types</strong>.
                  Load a sample to preview the result. For decimals going to INT64, choose the rounding behavior explicitly.
                  You can also select the BigQuery destination node and run its compatibility check if changing the target column is safer.
                </p>
              )}
            </div>
          ) : null}
          <Section title="Pipeline" pill="load a sample to simulate it live">
            <RoutePipelineCanvas
              routeId={route.id}
              routeStatus={route.status}
              routeUpdatedAt={route.updated_at}
              initialPipelineGraph={route.pipeline_graph}
              legacyFilter={route.filter_expression}
              legacyTransform={route.transform_script}
              source={focusSource}
              destinations={focusDestinations}
              bindingsByDestinationId={bindingsByDestinationId}
              canMutate={canMutate}
              initialEditMode={repairingData}
            />
            <FocusLegend />
          </Section>

          {route.filter_expression || route.transform_script || route.pipeline_graph ? (
            <Section title="Raw DSL (advanced)">
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  Show the engine declarations stored on this route
                </summary>
                <div className="mt-3 grid gap-4">
                  {route.pipeline_graph ? (
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Pipeline graph
                        </h3>
                        <CopyButton value={prettyDsl(route.pipeline_graph)} label="copy" />
                      </div>
                      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                        {prettyDsl(route.pipeline_graph)}
                      </pre>
                    </div>
                  ) : null}
                  {route.filter_expression ? (
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Filter (ƒ)
                        </h3>
                        <CopyButton value={prettyDsl(route.filter_expression)} label="copy" />
                      </div>
                      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                        {prettyDsl(route.filter_expression)}
                      </pre>
                    </div>
                  ) : null}
                  {route.transform_script ? (
                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Transform (↻)
                        </h3>
                        <CopyButton value={prettyDsl(route.transform_script)} label="copy" />
                      </div>
                      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
                        {prettyDsl(route.transform_script)}
                      </pre>
                    </div>
                  ) : null}
                </div>
              </details>
            </Section>
          ) : null}
        </>
      ) : null}

      {tab === "test" && route.status === "active" && (route.filter_expression || route.transform_script || route.pipeline_graph) ? (
        <Section
          title="Test against recent events"
          pill={
            route.pipeline_graph
              ? "runs the DAG executor over the last 10 events"
              : "runs the same engine the edge router uses"
          }
        >
          <TestRoutePanel routeId={route.id} sourceId={route.source_id} />
        </Section>
      ) : tab === "test" ? (
        <Section title="Test against recent events">
          <EmptyState
            title="Nothing to test"
            body="This route has no filter or transform — every event passes through unchanged."
          />
        </Section>
      ) : null}

      {tab === "events" ? (
      <Section title="Recent events" pill={`last ${recentEvents.length} · 24h window`}>
        {chError ? (
          <EmptyState title="Couldn't load route events" body={chError} />
        ) : !canUseAnalytics ? (
          <EmptyState
            title="Route analytics unavailable"
            body="Per-route event history is unavailable for this deployment."
          />
        ) : recentEvents.length === 0 ? (
          <EmptyState
            title="No events through this route yet"
            body={
              route.status !== "active"
                ? "This route is disabled — incoming events bypass it."
                : "Events that match this route will show up here within seconds, with delivery status per destination."
            }
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Event</TableHead>
                <TableHead>Received</TableHead>
                <TableHead>Size</TableHead>
                {focusDestinations.map((d) => (
                  <TableHead key={d.id} className="min-w-24">
                    {d.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {recentEvents.map((event) => (
                <TableRow key={event.event_id}>
                  <TableCell>
                    <Link
                      href={`/sources/${route.source_id}/events/${event.event_id}`}
                      prefetch={false}
                      className="font-mono text-[11px] text-foreground hover:underline"
                    >
                      <code>{event.event_id.slice(0, 18)}…</code>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <Link
                      href={`/sources/${route.source_id}/events/${event.event_id}`}
                      prefetch={false}
                      className="block"
                    >
                      <small>
                        <LocalTime value={clickhouseToIso(event.received_at)} />
                      </small>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm">
                    <Link
                      href={`/sources/${route.source_id}/events/${event.event_id}`}
                      prefetch={false}
                      className="block"
                    >
                      {formatBytes(event.size_bytes)}
                    </Link>
                  </TableCell>
                  {focusDestinations.map((d) => {
                    const status = event.delivery_status_by_destination[d.id];
                    return (
                      <TableCell key={d.id}>
                        {status ? (
                          <DeliveryStatusBadge status={status} className="capitalize" />
                        ) : (
                          <small className="text-xs text-muted-foreground">—</small>
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
      ) : null}

      {tab === "backfill" && canMutate ? (
        <Section
          title="Backfill captured events"
          pill="replays history into this route only"
        >
          <BackfillRouteForm routeId={route.id} activeJob={activeBackfillJob} />
        </Section>
      ) : null}

      {tab === "destinations" && canMutate ? (
        <Section title="Configuration">
          <div className="space-y-4">
            <RenameRouteForm routeId={route.id} currentName={route.name} />
            <div className="border-t border-border pt-4">
              {route.pipeline_graph ? (
                // A DAG route's destination set is part of its pipeline graph —
                // updateRouteDestinations refuses to rewrite it (rewriting
                // route_destinations without the graph would dead-letter the
                // route with graph_destination_not_attached). Don't render the
                // editable form whose submit is guaranteed to fail; show the
                // attached set read-only and point at the canvas instead.
                <PipelineManagedDestinations
                  routeId={route.id}
                  destinations={focusDestinations}
                />
              ) : (
                <EditRouteDestinationsForm
                  routeId={route.id}
                  sourceId={route.source_id}
                  destinations={allDestinationsResult.rows}
                  selectedDestinationIds={focusDestinations.map((d) => d.id)}
                  bindingsByDestinationId={bindingsByDestinationId}
                />
              )}
            </div>
            <div className="border-t border-border pt-4">
              <RouteActions routeId={route.id} status={route.status} canDelete={canDelete} />
            </div>
          </div>
          <small className="block text-xs text-muted-foreground">
            Created <LocalTime value={route.created_at} />
          </small>
        </Section>
      ) : null}
    </>
  );
}

/**
 * Read-only destination list for pipeline-graph (DAG) routes. Their
 * destination set lives in `pipeline_graph`, so the flat checkbox editor
 * can't apply here — edits happen on the pipeline canvas (Overview tab).
 */
function PipelineManagedDestinations({
  routeId,
  destinations,
}: {
  routeId: string;
  destinations: FocusDestination[];
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
        This route is managed in the pipeline canvas —{" "}
        <Link
          href={`/routes/${routeId}`}
          className="font-medium text-foreground underline-offset-2 hover:underline"
        >
          edit destinations there
        </Link>
        . Destination nodes are part of the route&rsquo;s pipeline graph, so
        they can&rsquo;t be swapped from this flat list.
      </div>
      {destinations.length === 0 ? (
        <p className="text-sm text-muted-foreground">No destinations attached.</p>
      ) : (
        <div className="divide-y divide-border/50">
          {destinations.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-2 py-2 first:pt-0 last:pb-0">
              <span className="flex-1 text-sm text-foreground">
                <Link href={`/destinations/${d.id}`} className="hover:underline">
                  {d.name}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">
                  - {d.type} ({d.id})
                </span>
              </span>
              {d.status === "disabled" ? <Badge variant="outline">disabled</Badge> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Coerce a ClickHouse `DateTime64(3)` server-rendered string ("2026-05-04 17:42:11.000",
 * UTC, no zone marker) into a real ISO-8601 string with the "Z" UTC suffix.
 */
function clickhouseToIso(raw: string): string {
  return raw.replace(" ", "T") + "Z";
}

/**
 * Pretty-print a serialized declarative DSL value. Falls back to the raw
 * string when JSON.parse fails so a corrupt row is still inspectable.
 */
function prettyDsl(serialized: string): string {
  try {
    return JSON.stringify(JSON.parse(serialized), null, 2);
  } catch {
    return serialized;
  }
}
