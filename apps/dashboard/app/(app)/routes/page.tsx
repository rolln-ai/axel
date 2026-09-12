import Link from "@/app/_components/NavigationLink";
import { EmptyState } from "../../EmptyState";
import { PageHeader } from "../../_components/PageHeader";
import { LocalTime } from "../../_components/LocalTime";
import { PipelineGoalDialog } from "./PipelineGoalDialog";
import { RouteQuickView } from "./RouteQuickView";
import { db } from "../../../lib/db";
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

interface RouteRow {
  id: string;
  name: string | null;
  source_id: string;
  source_name: string;
  status: "active" | "disabled" | "errored";
  has_filter: boolean;
  has_transform: boolean;
  destination_summary: string;
  created_at: string;
}

export default async function RoutesPage() {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const canMutate = session.activeWorkspace.role === "owner" || session.activeWorkspace.role === "admin";

  const [routesResult, sourcesResult, destinationsResult] = await Promise.all([
    db().query<RouteRow>(
      `SELECT r.id, r.name, r.source_id, s.name AS source_name, r.status,
              (
                r.filter_expression IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(COALESCE(r.pipeline_graph->'nodes', '[]'::jsonb)) node
                   WHERE node->>'kind' = 'filter'
                )
              ) AS has_filter,
              (
                r.transform_script IS NOT NULL
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(COALESCE(r.pipeline_graph->'nodes', '[]'::jsonb)) node
                   WHERE node->>'kind' = 'transform'
                )
              ) AS has_transform,
              COALESCE(
                (SELECT string_agg(d.type || ':' || COALESCE(d.name, d.id), ', ')
                   FROM route_destinations rd
                   JOIN destinations d ON d.id = rd.destination_id
                  WHERE rd.route_id = r.id),
                '—'
              ) AS destination_summary,
              r.created_at::text
         FROM routes r
         JOIN sources s ON s.id = r.source_id
        WHERE r.workspace_id = $1
        ORDER BY r.created_at DESC
        LIMIT 200`,
      [workspaceId],
    ),
    db().query<{ id: string; name: string }>(
      `SELECT id, name FROM sources WHERE workspace_id = $1 AND status = 'active' ORDER BY name`,
      [workspaceId],
    ),
    db().query<{ id: string; name: string | null; type: string }>(
      `SELECT id, name, type FROM destinations WHERE workspace_id = $1 AND status = 'active' ORDER BY name`,
      [workspaceId],
    ),
  ]);
  const routes = routesResult.rows;
  const sources = sourcesResult.rows;
  const destinations = destinationsResult.rows;

  const disabledReason = !canMutate
    ? "Owners and admins can create routes"
    : sources.length === 0
      ? "Create a source first"
      : destinations.length === 0
        ? "Create a destination first"
        : undefined;

  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Live pipelines"
        description="Each pipeline sends events from a source to a destination. Choose where events should flow and Axel will configure the details, validate against real events, and show you the mapping before it goes live."
        actions={
          canMutate ? (
            <div className="flex flex-col items-end gap-1.5">
              <PipelineGoalDialog
                sources={sources}
                destinations={destinations}
                {...(disabledReason ? { disabledReason } : {})}
              />
              {sources.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Create a{" "}
                  <Link
                    href="/sources"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    source
                  </Link>{" "}
                  before adding a pipeline.
                </p>
              ) : destinations.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Create a{" "}
                  <Link
                    href="/destinations"
                    className="font-medium text-foreground underline-offset-2 hover:underline"
                  >
                    destination
                  </Link>{" "}
                  before adding a pipeline.
                </p>
              ) : null}
            </div>
          ) : null
        }
      />

      <section className="rounded-lg border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-semibold text-foreground">{routes.length} active pipeline{routes.length === 1 ? "" : "s"}</h2>
        </div>
        {routes.length ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Pipeline</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Destinations</TableHead>
                <TableHead>Filter / transform</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {routes.map((route) => (
                <TableRow key={route.id}>
                  <TableCell>
                    <Link href={`/routes/${route.id}`} className="block">
                      <span className="text-sm font-medium text-foreground">
                        {route.name ?? route.id}
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/routes/${route.id}`} className="block">
                      <span className="text-sm text-foreground">{route.source_name}</span>{" "}
                      <small className="font-mono text-[11px] text-muted-foreground">{route.source_id}</small>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/routes/${route.id}`} className="block">
                      <small className="text-xs text-muted-foreground">{route.destination_summary}</small>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/routes/${route.id}`} className="flex items-center gap-1.5">
                      {route.has_filter ? (
                        <code className="rounded-sm bg-muted px-1 font-mono text-[11px]">ƒ filter</code>
                      ) : null}
                      {route.has_transform ? (
                        <code className="rounded-sm bg-muted px-1 font-mono text-[11px]">↻ transform</code>
                      ) : null}
                      {!route.has_filter && !route.has_transform ? (
                        <small className="text-xs text-muted-foreground">none</small>
                      ) : null}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link href={`/routes/${route.id}`} className="block">
                      <Badge
                        variant={
                          route.status === "active"
                            ? "default"
                            : route.status === "errored"
                              ? "destructive"
                              : "secondary"
                        }
                        className="capitalize"
                      >
                        {route.status}
                      </Badge>
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    <Link href={`/routes/${route.id}`} className="block">
                      <LocalTime value={route.created_at} mode="date" />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <RouteQuickView route={route} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-5">
            <EmptyState
              title="No routes configured"
              body={
                canMutate
                  ? "Choose where events should flow and review Axel's validated mapping preview before creating the pipeline."
                  : "Pipelines will appear here once an owner or admin creates them."
              }
            />
          </div>
        )}
      </section>
    </>
  );
}
