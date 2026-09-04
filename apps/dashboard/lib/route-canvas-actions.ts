"use server";

/**
 * Server actions for the route pipeline canvas.
 *
 *   - listRecentSamplePayloads / loadSamplePayload power the canvas's
 *     "load a real recent event" panel. Read-only ClickHouse + R2 lookups
 *     scoped to the caller's workspace + source. Same primitive as
 *     route-test-actions.ts, but exposed as discrete steps so the canvas
 *     can pick a payload lazily.
 *
 *   - savePipelineGraph persists a validated `pipeline_graph` JSON onto
 *     a route. Optimistic concurrency: the client passes the
 *     `expectedUpdatedAt` it saw at load time; we compare and bounce the
 *     save if someone else got there first, so two operators editing
 *     the same canvas don't silently clobber each other.
 */

import {
  RouteEngineError,
  parsePipelineGraph,
  validatePipelineGraph,
  type PipelineGraph,
} from "@axel/shared";
import { db } from "./db";
import { fetchPayloadForR2Key } from "./sample-payload";
import { requireSession } from "./session";
import { requireActiveWorkspace, requireWritableRole } from "./auth-guards";
import { clickhouse } from "./clickhouse";
import { usageEnabled } from "./usage";
import { updateTag } from "next/cache";
import { cacheTags } from "./repositories";
import { writeAudit } from "./audit";

export interface RecentSampleRow {
  event_id: string;
  received_at: string;
  size_bytes: number;
  content_type: string;
}

export type ListRecentSampleResult =
  | { ok: true; samples: RecentSampleRow[] }
  | { ok: false; reason: string };

const RECENT_LIMIT_DEFAULT = 10;
const RECENT_LIMIT_MAX = 50;

export async function listRecentSamplePayloads(
  sourceId: string,
  limit: number = RECENT_LIMIT_DEFAULT,
): Promise<ListRecentSampleResult> {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), RECENT_LIMIT_MAX);

  // Confirm the source belongs to this workspace before letting the
  // caller list recent payloads. Cheap defense-in-depth.
  const sourceRes = await db().query<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
    [sourceId, workspaceId],
  );
  if (sourceRes.rows.length === 0) return { ok: false, reason: "source_not_found" };

  if (!usageEnabled()) return { ok: false, reason: "clickhouse_not_configured" };

  try {
    const ch = clickhouse();
    const result = await ch.query<{
      event_id: string;
      received_at: string;
      size_bytes: number;
      content_type: string;
    }>(
      `SELECT event_id,
              toString(received_at) AS received_at,
              size_bytes,
              content_type
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND is_test = 0
        ORDER BY received_at DESC
        LIMIT {limit:UInt32}`,
      { workspace_id: workspaceId, source_id: sourceId, limit: safeLimit },
    );
    return { ok: true, samples: result.rows };
  } catch {
    console.error("[listRecentSamplePayloads] clickhouse failed");
    return { ok: false, reason: "clickhouse_failed" };
  }
}

export type LoadSampleResult =
  | { ok: true; payload: unknown; size_bytes: number; received_at: string }
  | { ok: false; reason: string };

// 2 MB cap — the browser starts to lag on JSON.parse + diff above this,
// and the canvas only needs a representative payload to preview. Same
// shape as the raw-payload-base64 5 MB cap, just tighter for in-browser
// use. Returns reason: "payload_too_large" when over.
const SAMPLE_PAYLOAD_BYTE_CAP = 2 * 1024 * 1024;

export async function loadSamplePayload(
  sourceId: string,
  eventId: string,
): Promise<LoadSampleResult> {
  const session = await requireSession();
  const workspaceId = session.activeWorkspace.workspace_id;

  if (!usageEnabled()) return { ok: false, reason: "clickhouse_not_configured" };

  let r2_key: string;
  let received_at: string;
  let size_bytes: number;
  try {
    const ch = clickhouse();
    const result = await ch.query<{
      r2_key: string;
      received_at: string;
      size_bytes: number;
    }>(
      `SELECT r2_key,
              toString(received_at) AS received_at,
              size_bytes
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND event_id = {event_id:String}
        LIMIT 1`,
      { workspace_id: workspaceId, source_id: sourceId, event_id: eventId },
    );
    if (result.rows.length === 0) return { ok: false, reason: "event_not_found" };
    r2_key = result.rows[0]!.r2_key;
    received_at = result.rows[0]!.received_at;
    size_bytes = result.rows[0]!.size_bytes;
  } catch {
    console.error("[loadSamplePayload] clickhouse failed");
    return { ok: false, reason: "clickhouse_failed" };
  }

  if (size_bytes > SAMPLE_PAYLOAD_BYTE_CAP) {
    return { ok: false, reason: "payload_too_large" };
  }

  const payload = await fetchPayloadForR2Key(r2_key, {
    workspaceId,
    eventId,
    sourceId,
  });
  if (payload === null) return { ok: false, reason: "r2_fetch_failed" };
  return { ok: true, payload, size_bytes, received_at };
}

export type SavePipelineGraphResult =
  | { ok: true; updated_at: string; graph: PipelineGraph }
  | {
      ok: false;
      reason: "stale_save";
      current: { pipeline_graph: PipelineGraph | null; updated_at: string };
    }
  | { ok: false; reason: "validation"; details: { reason: string; message: string } }
  | { ok: false; reason: "auth" | "not_found" | "forbidden" | "unknown" };

interface RouteRowForSave {
  id: string;
  pipeline_graph: string | null;
  updated_at: string;
}

interface AttachedDestinationRow {
  destination_id: string;
}

export async function savePipelineGraph(
  routeId: string,
  graphRaw: unknown,
  expectedUpdatedAt: string,
): Promise<SavePipelineGraphResult> {
  const session = await requireSession();
  // Shared guards; the canvas result envelope is reason-coded, so both the
  // role rejection and a suspended/deleted workspace map to "forbidden".
  if (requireWritableRole(session.activeWorkspace.role) !== null) {
    return { ok: false, reason: "forbidden" };
  }
  if (requireActiveWorkspace(session.activeWorkspace) !== null) {
    return { ok: false, reason: "forbidden" };
  }
  const workspaceId = session.activeWorkspace.workspace_id;

  // Load the route + its attached destinations in one round-trip so we
  // can build the validation context (destinations the user can wire
  // into the graph).
  const routeRes = await db().query<RouteRowForSave>(
    `SELECT id, pipeline_graph::text AS pipeline_graph, updated_at::text AS updated_at
       FROM routes
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [routeId, workspaceId],
  );
  const existing = routeRes.rows[0];
  if (!existing) return { ok: false, reason: "not_found" };

  const destsRes = await db().query<AttachedDestinationRow>(
    `SELECT destination_id FROM route_destinations WHERE route_id = $1`,
    [routeId],
  );
  const attached = new Set(destsRes.rows.map((r) => r.destination_id));

  let validated: PipelineGraph;
  try {
    validated = validatePipelineGraph(graphRaw, {
      attached_destination_ids: attached,
    });
  } catch (err) {
    const reason = err instanceof RouteEngineError ? err.reason : "graph_invalid";
    return {
      ok: false,
      reason: "validation",
      details: { reason, message: "Pipeline graph validation failed." },
    };
  }

  const serialized = JSON.stringify(validated);

  // Optimistic concurrency: only update if updated_at matches what the
  // caller saw. When zero rows update we know either (a) the route
  // vanished or (b) someone else got there first — re-fetch + report.
  const updateRes = await db().query<{ updated_at: string }>(
    `UPDATE routes
        SET pipeline_graph = $1::jsonb,
            filter_expression = NULL,
            transform_script = NULL,
            updated_at = now()
      WHERE id = $2
        AND workspace_id = $3
        AND updated_at = $4::timestamptz
      RETURNING updated_at::text AS updated_at`,
    [serialized, routeId, workspaceId, expectedUpdatedAt],
  );

  if (updateRes.rowCount === 0) {
    // Either stale or the row vanished — fetch the current shape so the
    // UI can decide what to do next.
    const fresh = await db().query<RouteRowForSave>(
      `SELECT id, pipeline_graph::text AS pipeline_graph, updated_at::text AS updated_at
         FROM routes
        WHERE id = $1 AND workspace_id = $2
        LIMIT 1`,
      [routeId, workspaceId],
    );
    if (fresh.rows.length === 0) return { ok: false, reason: "not_found" };
    let currentGraph: PipelineGraph | null = null;
    if (fresh.rows[0]!.pipeline_graph) {
      try {
        currentGraph = parsePipelineGraph(fresh.rows[0]!.pipeline_graph, {
          attached_destination_ids: attached,
        });
      } catch {
        currentGraph = null;
      }
    }
    return {
      ok: false,
      reason: "stale_save",
      current: {
        pipeline_graph: currentGraph,
        updated_at: fresh.rows[0]!.updated_at,
      },
    };
  }

  await writeAudit(db(), {
    workspaceId,
    actorUserId: session.user.id,
    action: existing.pipeline_graph === null
      ? "route.pipeline_graph_initialized"
      : "route.pipeline_graph_updated",
    targetType: "route",
    targetId: routeId,
    metadata: {
      node_count: validated.nodes.length,
      edge_count: validated.edges.length,
      destination_leaves: validated.nodes.filter((n) => n.kind === "destination").length,
    },
  });

  updateTag(cacheTags.routes(workspaceId));

  return {
    ok: true,
    updated_at: updateRes.rows[0]!.updated_at,
    graph: validated,
  };
}
