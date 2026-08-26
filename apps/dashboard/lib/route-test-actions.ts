"use server";

/**
 * Server actions for the "Test against recent events" panel on a route's
 * detail page. Pure read-only: never enqueues deliveries, never writes
 * to ClickHouse, never touches the dead-letter queue.
 *
 * Two execution paths, mirroring the dual-mode router:
 *   - Legacy route (filter_expression / transform_script): apply filter,
 *     then transform, then report a single before/after pair.
 *   - DAG route (pipeline_graph): run executeGraph, report the per-leaf
 *     deliveries it would produce.
 */

import {
  executeGraph,
  parseFilter,
  parsePipelineGraph,
  parseTransform,
  RouteEngineError,
  runFilter,
  runTransform,
} from "@axel/shared";
import { db } from "./db";
import { fetchPayloadForR2Key } from "./sample-payload";
import { requireSession } from "./session";
import { requireActiveWorkspace } from "./auth-guards";
import { clickhouse } from "./clickhouse";
import { usageEnabled } from "./usage";

export interface TestRouteResultLeaf {
  destination_id: string;
  leaf_node_id: string;
  payload: unknown;
}

export interface TestRouteResult {
  event_id: string;
  received_at: string;
  payload_before: unknown;
  /** Legacy single-shape route — null when DAG mode. */
  payload_after: unknown;
  /** DAG-shape route — empty for legacy. One entry per leaf delivery. */
  deliveries: TestRouteResultLeaf[];
  skipped: boolean;
  error: { reason: string; message: string } | null;
}

interface RouteRow {
  filter_expression: string | null;
  transform_script: string | null;
  pipeline_graph: string | null;
}

interface AttachedDestinationRow {
  destination_id: string;
}

interface RecentEventRow {
  event_id: string;
  received_at: string;
  r2_key: string;
  content_type: string;
}

const RECENT_EVENT_LIMIT = 10;

export async function testRouteAgainstRecentEvents(
  routeId: string,
  sourceId: string,
): Promise<{ results: TestRouteResult[] } | { error: string }> {
  const session = await requireSession();
  // Suspended/deleted workspaces keep read access to their data but lose the
  // operator tooling that executes transforms / fetches payloads on demand.
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const workspaceId = session.activeWorkspace.workspace_id;

  // Confirm the route belongs to this workspace + source. Without this
  // an operator could test arbitrary route IDs against arbitrary
  // sources by guessing — cheap defense-in-depth check.
  const routeRes = await db().query<RouteRow>(
    `SELECT filter_expression, transform_script, pipeline_graph::text AS pipeline_graph
       FROM routes
      WHERE id = $1 AND workspace_id = $2 AND source_id = $3
      LIMIT 1`,
    [routeId, workspaceId, sourceId],
  );
  const route = routeRes.rows[0];
  if (!route) return { error: "Route not found in this workspace." };
  if (!route.filter_expression && !route.transform_script && !route.pipeline_graph) {
    return { error: "Route is passthrough — nothing to test." };
  }

  // For DAG routes we need the route's attached destinations so the
  // shared validator can verify the graph references real destinations.
  let attachedDestinationIds: Set<string> | null = null;
  if (route.pipeline_graph) {
    const destsRes = await db().query<AttachedDestinationRow>(
      `SELECT destination_id FROM route_destinations WHERE route_id = $1`,
      [routeId],
    );
    attachedDestinationIds = new Set(destsRes.rows.map((r) => r.destination_id));
  }

  if (!usageEnabled()) {
    return { error: "ClickHouse is not configured on the dashboard, so recent events can't be queried." };
  }

  let recent: RecentEventRow[] = [];
  try {
    const ch = clickhouse();
    const result = await ch.query<{
      event_id: string;
      received_at: string;
      r2_key: string;
      content_type: string;
    }>(
      `SELECT event_id,
              toString(received_at) AS received_at,
              r2_key,
              content_type
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND is_test = 0
        ORDER BY received_at DESC
        LIMIT {limit:UInt32}`,
      { workspace_id: workspaceId, source_id: sourceId, limit: RECENT_EVENT_LIMIT },
    );
    recent = result.rows;
  } catch (err) {
    return { error: err instanceof Error ? err.message : "ClickHouse query failed." };
  }

  // Bounded parallelism — the R2 fetches dominate latency, so issue
  // them all in parallel rather than serialising. 10 small fetches is
  // well under any provider/runtime limit.
  const results = await Promise.all(
    recent.map(async (event): Promise<TestRouteResult> => {
      let payloadBefore: unknown;
      try {
        payloadBefore = await fetchPayloadForR2Key(event.r2_key);
      } catch {
        payloadBefore = null;
      }
      if (payloadBefore === null) {
        return {
          event_id: event.event_id,
          received_at: event.received_at,
          payload_before: null,
          payload_after: null,
          deliveries: [],
          skipped: false,
          error: { reason: "r2_fetch_failed", message: "Could not load the raw payload from R2." },
        };
      }

      try {
        if (route.pipeline_graph && attachedDestinationIds) {
          // DAG path — run the graph and report per-leaf deliveries.
          const graph = parsePipelineGraph(route.pipeline_graph, {
            attached_destination_ids: attachedDestinationIds,
          });
          const { deliveries } = executeGraph(payloadBefore, graph);
          return {
            event_id: event.event_id,
            received_at: event.received_at,
            payload_before: payloadBefore,
            payload_after: null,
            deliveries: deliveries.map((d) => ({
              destination_id: d.destination_id,
              leaf_node_id: d.leaf_node_id,
              payload: d.payload,
            })),
            skipped: deliveries.length === 0,
            error: null,
          };
        }

        // Legacy path — single filter + single transform.
        let skip = false;
        if (route.filter_expression) {
          const filter = parseFilter(route.filter_expression);
          if (!runFilter(payloadBefore, filter)) skip = true;
        }
        let payloadAfter: unknown = payloadBefore;
        if (!skip && route.transform_script) {
          const transform = parseTransform(route.transform_script);
          payloadAfter = runTransform(payloadBefore, transform);
        }
        return {
          event_id: event.event_id,
          received_at: event.received_at,
          payload_before: payloadBefore,
          payload_after: payloadAfter,
          deliveries: [],
          skipped: skip,
          error: null,
        };
      } catch (err) {
        const reason = err instanceof RouteEngineError ? err.reason : "engine_error";
        const message = err instanceof Error ? err.message : String(err);
        return {
          event_id: event.event_id,
          received_at: event.received_at,
          payload_before: payloadBefore,
          payload_after: null,
          deliveries: [],
          skipped: false,
          error: { reason, message: message.slice(0, 400) },
        };
      }
    }),
  );

  return { results };
}
