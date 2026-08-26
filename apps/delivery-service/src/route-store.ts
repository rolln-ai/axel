/**
 * Single active-route loader for delivery-service.
 *
 * The same three-query lookup (active routes / source field_selection /
 * route_destinations+destinations join) used to exist twice — server.ts's
 * `loadActiveRoutesForWorker` (feeding `/internal/routes` for router-edge)
 * and replay-worker's `createPgRouteStore` (feeding the in-process replay
 * router) — and each had independently accumulated bug-fix comments about
 * `binding` and `pipeline_graph` being forgotten. This module is now the one
 * implementation; both call sites consume it.
 *
 * The returned shape is the canonical snake_case `Route` from @axel/shared
 * (`field_selection`, always present, null when unset/empty) plus the
 * per-destination `destinationTypes` map the routers use for the edge/native
 * queue split. The `/internal/routes` HTTP boundary additionally mirrors
 * `field_selection` into the legacy camelCase `fieldSelection` key —
 * see server.ts — so router-edge never needs a lockstep deploy.
 */

import type { Pool } from "pg";
import type { Route, RouteDestinationBinding } from "@axel/shared";

export type RouteWithDestinationTypes = Route & {
  destinationTypes: Record<string, string>;
};

/** Optional transient-retry wrapper (server.ts passes withPgRetry; the replay
 *  worker runs bare queries, preserving its existing behavior). */
export type PgRetry = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

const noRetry: PgRetry = (_label, fn) => fn();

export async function loadActiveRoutes(
  pool: Pool,
  workspaceId: string,
  sourceId: string,
  opts: { withRetry?: PgRetry } = {},
): Promise<RouteWithDestinationTypes[]> {
  const retry = opts.withRetry ?? noRetry;

  const [routesRes, sourceRes] = await Promise.all([
    retry("internal-routes-list", () =>
      pool.query<{
        id: string;
        workspace_id: string;
        source_id: string;
        status: "active" | "disabled" | "errored";
        engine: "legacy_js" | "declarative";
        filter_expression: string | null;
        transform_script: string | null;
        pipeline_graph: string | null;
      }>(
        // pipeline_graph must be selected so DAG-form routes route through the
        // same graph on live traffic AND replay (post-0036 DAG routes have NULL
        // legacy columns; without it they'd flow untransformed).
        `SELECT id::text AS id, workspace_id::text AS workspace_id, source_id::text AS source_id,
                status, engine, filter_expression, transform_script,
                pipeline_graph::text AS pipeline_graph
           FROM routes
          WHERE workspace_id::text = $1 AND source_id::text = $2 AND status = 'active'`,
        [workspaceId, sourceId],
      ),
    ),
    // The source's field_selection (same for every route on the source) so the
    // routers can project the delivered payload at fan-out.
    retry("internal-routes-source", () =>
      pool.query<{ field_selection: string[] | null }>(
        `SELECT field_selection FROM sources WHERE id::text = $1 AND workspace_id::text = $2 LIMIT 1`,
        [sourceId, workspaceId],
      ),
    ),
  ]);

  if (routesRes.rows.length === 0) return [];
  const rawSelection = sourceRes.rows[0]?.field_selection ?? null;
  const fieldSelection = rawSelection && rawSelection.length > 0 ? rawSelection : null;

  const routeIds = routesRes.rows.map((r) => r.id);
  // Compare as text on both sides so we don't depend on pg's array-element
  // type inference (`$1::uuid[]` used to throw `operator does not exist:
  // text = uuid`). rd.binding carries the per-route destination binding (e.g.
  // an S3-parquet destination's `format`); without it
  // requiresNativeRuntimeDestination can't see parquet and mis-routes to the
  // edge worker.
  const destsRes = await retry("internal-routes-destinations", () =>
    pool.query<{
      route_id: string;
      destination_id: string;
      destination_type: string;
      binding: RouteDestinationBinding | null;
    }>(
      `SELECT rd.route_id::text AS route_id,
              rd.destination_id::text AS destination_id,
              d.type::text AS destination_type,
              rd.binding AS binding
         FROM route_destinations rd
         JOIN destinations d ON d.id = rd.destination_id
        WHERE rd.route_id::text = ANY($1::text[])
          AND d.status = 'active'`,
      [routeIds],
    ),
  );

  const byRoute = new Map<string, string[]>();
  const typesByRoute = new Map<string, Record<string, string>>();
  const bindingsByRoute = new Map<string, Record<string, RouteDestinationBinding | null>>();
  for (const d of destsRes.rows) {
    const arr = byRoute.get(d.route_id) ?? [];
    arr.push(d.destination_id);
    byRoute.set(d.route_id, arr);
    const typeMap = typesByRoute.get(d.route_id) ?? {};
    typeMap[d.destination_id] = d.destination_type;
    typesByRoute.set(d.route_id, typeMap);
    const bindingMap = bindingsByRoute.get(d.route_id) ?? {};
    bindingMap[d.destination_id] = d.binding ?? null;
    bindingsByRoute.set(d.route_id, bindingMap);
  }

  return routesRes.rows.map((r) => ({
    route_id: r.id,
    workspace_id: r.workspace_id,
    source_id: r.source_id,
    status: r.status,
    engine: r.engine,
    ...(r.filter_expression !== null ? { filter_expression: r.filter_expression } : {}),
    ...(r.transform_script !== null ? { transform_script: r.transform_script } : {}),
    ...(r.pipeline_graph !== null ? { pipeline_graph: r.pipeline_graph } : {}),
    field_selection: fieldSelection,
    destination_ids: byRoute.get(r.id) ?? [],
    destinationTypes: typesByRoute.get(r.id) ?? {},
    destination_bindings: bindingsByRoute.get(r.id) ?? {},
  }));
}

/**
 * Mark a route errored (engine breach). Shared by the replay router's
 * RouteStore (no workspace in its interface — pass null) and the
 * `/internal/routes/errored` endpoint router-edge calls (workspace-scoped,
 * since the id comes off the wire), so a bad graph auto-disables the route
 * regardless of which runtime hit it.
 */
export async function markRouteErrored(
  pool: Pool,
  workspaceId: string | null,
  routeId: string,
  reason: string,
  message: string,
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE routes
        SET status = 'errored',
            error_reason = $2,
            error_message = $3,
            updated_at = now()
      WHERE id::text = $1
        AND ($4::text IS NULL OR workspace_id::text = $4::text)`,
    [routeId, reason, message.slice(0, 1000), workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}
