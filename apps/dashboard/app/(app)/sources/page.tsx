import Link from "@/app/_components/NavigationLink";
import { Suspense } from "react";
import { LoaderCircle } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "../../EmptyState";
import { FirstRunOnboardingCard } from "../_components/FirstRunOnboardingCard";
import { PageHeader } from "../../_components/PageHeader";
import { LocalTime } from "../../_components/LocalTime";
import { EntityStatusBadge } from "../../_components/StatusBadges";
import { NewSourcePipelineDialog } from "./NewSourcePipelineDialog";
import { Button } from "@/components/ui/button";
import { SourceActions } from "./SourceActions";
import { SourceQuickView } from "./SourceQuickView";
import { listSources } from "../../../lib/repositories";
import { listDestinationsWithRouteCount } from "../../../lib/destinations";
import { db } from "../../../lib/db";
import { requireSession } from "../../../lib/session";
import {
  formatCount,
  getSourceEventCountsByWindowCached,
  usageEnabled,
  type SourceEventCounts,
} from "../../../lib/usage";
import { Badge } from "@/components/ui/badge";
import { resolveIngestBaseUrl } from "@axel/shared";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

async function loadSourceEventCounts(workspaceId: string): Promise<Map<string, SourceEventCounts>> {
  if (!usageEnabled()) return new Map();
  try {
    const rows = await getSourceEventCountsByWindowCached(workspaceId);
    return new Map(rows.map((row) => [row.source_id, row]));
  } catch {
    return new Map();
  }
}

export default async function SourcesPage() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const eventCounts = loadSourceEventCounts(workspaceId);
  const [sources, destinationsRaw] = await Promise.all([
    listSources(workspaceId),
    listDestinationsWithRouteCount(workspaceId, db()),
  ]);
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";
  const canDelete = session.activeWorkspace.role === "owner";
  // Same derivation as the source detail page — the Quick View panel's
  // copyable ingest snippet must point at this deployment's ingest host.
  const ingestBase = resolveIngestBaseUrl(process.env);
  const visibleSources = sources.filter((source) => source.source_kind === "webhook");
  // Pull-source creation is intentionally retired (webhook-only wizard), but a
  // workspace that already has pull sources must still see them — they keep
  // syncing in the background. Surface them in a separate legacy section
  // below the primary webhook list instead of silently hiding them.
  const pullSources = sources.filter((source) => source.source_kind !== "webhook");
  const existingDestinations = destinationsRaw
    .filter((d) => d.status === "active")
    .map((d) => ({ id: d.id, name: d.name ?? "(unnamed)", type: d.type }));

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Sources"
        description="Webhook sources for receiving pushed events. Every event fans out through routes to the destinations you choose."
        actions={canMutate ? <NewSourcePipelineDialog existingDestinations={existingDestinations} /> : null}
      />

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{visibleSources.length} configured</h2>
        </div>
        {visibleSources.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Rate cap</TableHead>
                <TableHead className="text-right">Events 24h</TableHead>
                <TableHead className="text-right">Events 30d</TableHead>
                <TableHead className="text-right">Events all time</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
                {canMutate ? <TableHead className="text-right">Actions</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleSources.map((source) => {
                return (
                  <TableRow key={source.id}>
                    <TableCell>
                      <Link href={`/sources/${source.id}`} className="block">
                        <strong className="text-sm font-medium text-foreground">{source.name}</strong>
                        <small className="block font-mono text-[11px] text-muted-foreground">
                          {source.id}
                        </small>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {source.source_kind}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <EntityStatusBadge status={source.status} className="capitalize" />
                    </TableCell>
                    <TableCell className="text-sm">
                      {`${source.max_events_per_minute ?? "default"}/min`}
                    </TableCell>
                    <Suspense fallback={<EventCountCellsLoading />}>
                      <EventCountCells sourceId={source.id} countsPromise={eventCounts} />
                    </Suspense>
                    <TableCell className="text-sm text-muted-foreground">
                      <LocalTime value={source.created_at} mode="date" />
                    </TableCell>
                    <TableCell>
                      <SourceQuickView
                        source={{
                          id: source.id,
                          name: source.name,
                          status: source.status,
                          max_events_per_minute: source.max_events_per_minute,
                          created_at: source.created_at,
                          provider: source.provider,
                        }}
                        ingestUrl={`${ingestBase}/in/${source.id}`}
                      />
                    </TableCell>
                    {canMutate ? (
                      <TableCell className="text-right">
                        <SourceActions sourceId={source.id} status={source.status} canDelete={canDelete} />
                      </TableCell>
                    ) : null}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : (
          <div className="p-5">
            {canMutate ? (
              // First source: send them through the guided /setup flow rather
              // than the all-in-one modal (ROL-448 / ROL-457).
              <FirstRunOnboardingCard
                trigger={
                  <Button size="sm" asChild>
                    <Link href="/setup">Set up your first source</Link>
                  </Button>
                }
              />
            ) : (
              <EmptyState
                title="No sources yet"
                body="Once an owner creates the first source, it will appear here."
              />
            )}
          </div>
        )}
      </section>

      {pullSources.length ? (
        <section className="mt-6 rounded-lg border border-border bg-card">
          <div className="border-b border-border px-5 py-3">
            <h2 className="text-sm font-semibold text-foreground">
              Pull sources (legacy) · {pullSources.length}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              These scheduled pull sources keep syncing on their existing cadence, but new pull
              sources can no longer be created. Open a source to view sync status or manage it.
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Events 24h</TableHead>
                <TableHead className="text-right">Events 30d</TableHead>
                <TableHead className="text-right">Events all time</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pullSources.map((source) => {
                return (
                  <TableRow key={source.id}>
                    <TableCell>
                      <Link href={`/sources/${source.id}`} className="block">
                        <strong className="text-sm font-medium text-foreground">{source.name}</strong>
                        <small className="block font-mono text-[11px] text-muted-foreground">
                          {source.id}
                        </small>
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {source.source_kind}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <EntityStatusBadge status={source.status} className="capitalize" />
                    </TableCell>
                    <Suspense fallback={<EventCountCellsLoading />}>
                      <EventCountCells sourceId={source.id} countsPromise={eventCounts} />
                    </Suspense>
                    <TableCell className="text-sm text-muted-foreground">
                      <LocalTime value={source.created_at} mode="date" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </>
  );
}

function EventCountCellsLoading() {
  return (
    <>
      <TableCell className="text-right" aria-busy="true">
        <span role="status" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          Loading counts…
        </span>
      </TableCell>
      <TableCell><Skeleton className="ml-auto h-4 w-16" /></TableCell>
      <TableCell><Skeleton className="ml-auto h-4 w-16" /></TableCell>
    </>
  );
}

async function EventCountCells({ sourceId, countsPromise }: {
  sourceId: string;
  countsPromise: Promise<Map<string, SourceEventCounts>>;
}) {
  const counts = (await countsPromise).get(sourceId);
  return (
    <>
      {[counts?.events_24h, counts?.events_30d, counts?.events_all].map((count, index) => (
        <TableCell key={index} className="text-right text-sm tabular-nums">
          {count === undefined ? <span title="Event counts unavailable">—</span> : formatCount(count)}
        </TableCell>
      ))}
    </>
  );
}
