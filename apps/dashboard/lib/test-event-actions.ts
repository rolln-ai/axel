"use server";

// Test-event server actions: send a test event and observe its routing/delivery outcome.

import { resolveIngestBaseUrl } from "@axel/shared";
import { db } from "./db";
import { withWorkspaceMutation } from "./with-mutation";
import { clickhouse } from "./clickhouse";
import { usageEnabled, listSourceEvents } from "./usage";
import type { ActionState } from "./action-data";

/**
 * AXE-25 — Send test event. POSTs to ingest-worker's
 * `/admin/trigger-event` which mints a real UUIDv7, writes to R2,
 * and enqueues onto the same shard queue the public /in/<id>
 * endpoint uses (with `is_test: true` so downstream consumers
 * render it distinctly + don't bill against it).
 *
 * Workspace ownership is enforced both here (SELECT 1 FROM
 * sources) and inside the ingest worker (source authority lookup +
 * status check).
 */
export async function sendTestEvent(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    const sourceId = formData.get("source_id");
    if (typeof sourceId !== "string") return { error: "Missing source." };

    const payloadRaw = formData.get("payload");
    if (typeof payloadRaw !== "string") return { error: "Missing payload." };

    let payloadJson: unknown;
    try {
      payloadJson = JSON.parse(payloadRaw);
    } catch {
      return { error: "Invalid JSON payload. Fix before sending." };
    }

    // Workspace ownership check before hitting the admin endpoint —
    // ingest re-checks but failing fast here gives a clearer error
    // and keeps the admin surface narrower.
    const sourceCheck = await db().query(
      `SELECT 1 FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [sourceId, workspaceId],
    );
    if ((sourceCheck.rowCount ?? 0) === 0) {
      return { error: "Source not found in this workspace." };
    }

    let ingestBase: string;
    try {
      ingestBase = resolveIngestBaseUrl(process.env);
    } catch {
      return { error: "Test-event service is not configured." };
    }
    const adminToken = process.env.INGEST_ADMIN_TOKEN;
    if (!adminToken) {
      return { error: "Test-event service is not configured." };
    }

    try {
      const res = await fetch(`${ingestBase.replace(/\/$/, "")}/admin/trigger-event`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-axel-admin-token": adminToken,
        },
        body: JSON.stringify({
          source_id: sourceId,
          body: payloadJson,
          headers: { "content-type": "application/json", "x-axel-test-source": "dashboard" },
          content_type: "application/json",
          actor_kind: "dashboard_send_test_event",
        }),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { error: `Ingest rejected the test event (HTTP ${res.status}).` };
      }
      const body = (await res.json().catch(() => ({}))) as { event_id?: string };
      const eventId = body.event_id;
      if (!eventId) {
        return { error: "Ingest accepted the test event but did not return an event reference." };
      }
      await audit({
        action: "source.test_event_sent",
        targetType: "source",
        targetId: sourceId,
        metadata: { event_id: eventId },
      });
      return {
        notice: "Test event sent. It follows the normal route and delivery path without counting against usage.",
        // `eventId` lets the dialog poll getTestEventOutcome() for the REAL
        // routing/delivery result. `sourceId` is kept for backwards-compat
        // with any caller that still reads the old (mislabelled) field.
        data: { eventId, sourceId: eventId },
      };
    } catch {
      return { error: "Couldn't reach the ingest worker." };
    }
  });
}

/**
 * AXE-25 — read the REAL outcome of a sent test event so the
 * Send-test-event dialog can show whether it actually routed and
 * delivered, instead of a fabricated "everything worked" result.
 *
 * Queries the two ClickHouse log tables for the test event:
 *   - route_evaluations → which routes matched (status = 'matched').
 *     This table is only populated once the router writes evaluations;
 *     until then we derive matched routes from any delivery_attempts rows
 *     (a delivery only exists downstream of a route match).
 *   - delivery_attempts  → per-destination attempts (status, http_status,
 *     latency). The latest attempt per (route, destination) wins.
 *
 * Scoped to the caller's workspace AND the exact event_id. We deliberately do
 * NOT filter on is_test: the delivery_attempts / route_evaluations writers
 * don't stamp that column, and the test event_id is a unique uuidv7 the caller
 * just minted, so (workspace_id, event_id) already isolates this one event and
 * can't read another workspace's traffic. Read-only: never writes/enqueues.
 *
 * `pending` is true while the event has been accepted but nothing has
 * been logged yet (the router/delivery pipeline is still catching up),
 * which the dialog renders as an honest "Awaiting delivery…" state.
 */
export interface TestEventMatchedRoute {
  route_id: string;
  /** Human label — routes have no name column, so derive from engine/shape. */
  label: string;
}

export interface TestEventDeliveryAttempt {
  destination_id: string;
  /** Destination display name, or null when it has been deleted since. */
  destination_name: string | null;
  route_id: string;
  status: "success" | "retry" | "dead" | string;
  http_status: number | null;
  latency_ms: number;
  error: string | null;
}

export interface TestEventOutcome {
  event_id: string;
  matched_routes: TestEventMatchedRoute[];
  delivery_attempts: TestEventDeliveryAttempt[];
  /** True once at least one route matched (or a delivery was attempted). */
  any_matched: boolean;
  /** True once at least one delivery attempt has been logged. */
  any_delivered: boolean;
  /**
   * True while we've found no evaluations and no attempts yet — the
   * pipeline is presumably still processing. The dialog keeps polling.
   */
  pending: boolean;
}

export async function getTestEventOutcome(
  eventId: string,
): Promise<{ outcome: TestEventOutcome } | { error: string }> {
  return withWorkspaceMutation({ role: "any" }, async ({ workspaceId }) => {

    if (typeof eventId !== "string" || !eventId) {
      return { error: "Missing event id." };
    }
    if (!usageEnabled()) {
      return { error: "ClickHouse is not configured on the dashboard, so test-event results can't be read." };
    }

    let evalRows: Array<{ route_id: string; status: string }> = [];
    let attemptRows: Array<{
      route_id: string;
      destination_id: string;
      status: string;
      latency_ms: string | number;
      response_json: string;
    }> = [];
    try {
      const ch = clickhouse();
      // Matched routes — latest evaluation status per route for this test
      // event. route_evaluations writes one row per (event, route); we take
      // the most recent so a re-evaluated route reflects its final verdict.
      const evalRes = await ch.query<{ route_id: string; status: string }>(
        `SELECT route_id,
                argMax(status, evaluated_at) AS status
           FROM route_evaluations
          WHERE workspace_id = {workspace_id:String}
            AND event_id = {event_id:String}
          GROUP BY route_id`,
        { workspace_id: workspaceId, event_id: eventId },
      );
      evalRows = evalRes.rows;

      // Delivery attempts — latest attempt per (route, destination). We pull
      // latency + response_json (which carries http_status / error) so the
      // dialog can show exactly what each destination returned.
      const attemptRes = await ch.query<{
        route_id: string;
        destination_id: string;
        status: string;
        latency_ms: string | number;
        response_json: string;
      }>(
        `SELECT route_id,
                destination_id,
                argMax(status, created_at)       AS status,
                argMax(latency_ms, created_at)   AS latency_ms,
                argMax(response_json, created_at) AS response_json
           FROM delivery_attempts
          WHERE workspace_id = {workspace_id:String}
            AND event_id = {event_id:String}
          GROUP BY route_id, destination_id`,
        { workspace_id: workspaceId, event_id: eventId },
      );
      attemptRows = attemptRes.rows;
    } catch {
      return { error: "Test-event results are temporarily unavailable." };
    }

    // A route counts as "matched" if route_evaluations says so, OR if it
    // produced a delivery attempt (a delivery can only exist downstream of a
    // match). The OR keeps results honest even before route_evaluations is
    // wired up in the router.
    const matchedIds = new Set<string>();
    for (const row of evalRows) {
      if (row.status === "matched") matchedIds.add(row.route_id);
    }
    for (const row of attemptRows) {
      if (row.route_id) matchedIds.add(row.route_id);
    }

    // Resolve human labels for the matched routes + destination names. Routes
    // have no name column, so we describe them by engine/shape; destinations
    // have a (nullable) name. Both scoped to the workspace.
    const routeLabels = new Map<string, string>();
    if (matchedIds.size > 0) {
      const routeRows = await db().query<{
        id: string;
        engine: string;
        filter_expression: string | null;
        transform_script: string | null;
        pipeline_graph: string | null;
      }>(
        `SELECT id, engine, filter_expression, transform_script,
                CASE WHEN pipeline_graph IS NULL THEN NULL ELSE 'present' END AS pipeline_graph
           FROM routes
          WHERE workspace_id = $1 AND id = ANY($2::text[])`,
        [workspaceId, Array.from(matchedIds)],
      );
      for (const r of routeRows.rows) {
        routeLabels.set(r.id, describeRouteLabel(r));
      }
    }

    const destinationNames = new Map<string, string | null>();
    const destIds = Array.from(new Set(attemptRows.map((a) => a.destination_id).filter(Boolean)));
    if (destIds.length > 0) {
      const destRows = await db().query<{ id: string; name: string | null }>(
        `SELECT id, name FROM destinations WHERE workspace_id = $1 AND id = ANY($2::text[])`,
        [workspaceId, destIds],
      );
      for (const d of destRows.rows) destinationNames.set(d.id, d.name);
    }

    const matched_routes: TestEventMatchedRoute[] = Array.from(matchedIds).map((id) => ({
      route_id: id,
      label: routeLabels.get(id) ?? `Route ${id.slice(0, 12)}`,
    }));

    const delivery_attempts: TestEventDeliveryAttempt[] = attemptRows.map((row) => {
      const parsed = ((): { http_status?: number; error?: string } => {
        if (!row.response_json) return {};
        try {
          return JSON.parse(row.response_json) as { http_status?: number; error?: string };
        } catch {
          return {};
        }
      })();
      return {
        destination_id: row.destination_id,
        destination_name: destinationNames.get(row.destination_id) ?? null,
        route_id: row.route_id,
        status: row.status,
        http_status: typeof parsed.http_status === "number" ? parsed.http_status : null,
        latency_ms: typeof row.latency_ms === "number" ? row.latency_ms : Number(row.latency_ms) || 0,
        error: typeof parsed.error === "string" ? "Delivery failed." : null,
      };
    });

    const any_matched = matched_routes.length > 0;
    const any_delivered = delivery_attempts.length > 0;

    return {
      outcome: {
        event_id: eventId,
        matched_routes,
        delivery_attempts,
        any_matched,
        any_delivered,
        // Still "pending" only when we've seen literally nothing yet — i.e.
        // routes may still be matching / deliveries still in flight.
        pending: !any_matched && !any_delivered,
      },
    };
  });
}

export interface RecentIngestEvent {
  eventId: string;
  receivedAt: string;
  sizeBytes: number;
  contentType: string;
}

/**
 * Live "is anything arriving yet?" poll for the New Source wizard's activation
 * step. Returns the most recent events ingested for a single source, newest
 * first, so the dialog can watch the endpoint and surface real provider traffic
 * the moment it lands — instead of asking the operator to fire a synthetic test
 * event. The underlying query is scoped to (workspace_id, source_id), so a
 * mismatched id simply yields nothing; there's no cross-workspace leak.
 *
 * Returns an empty list (not an error) when ClickHouse is unconfigured so the
 * monitor can degrade to a benign "waiting" state in local/degraded envs.
 */
export async function getRecentIngestEvents(
  sourceId: string,
  limit = 5,
): Promise<{ events: RecentIngestEvent[] } | { error: string }> {
  return withWorkspaceMutation({ role: "any" }, async ({ workspaceId }) => {

    if (typeof sourceId !== "string" || !sourceId) {
      return { error: "Missing source id." };
    }
    if (!usageEnabled()) return { events: [] };

    try {
      const rows = await listSourceEvents(workspaceId, sourceId, Math.min(Math.max(limit, 1), 20));
      return {
        events: rows.map((r) => ({
          eventId: r.event_id,
          receivedAt: r.received_at,
          sizeBytes: r.size_bytes,
          contentType: r.content_type,
        })),
      };
    } catch {
      return { error: "Recent ingest activity is temporarily unavailable." };
    }
  });
}

/**
 * Routes have no `name` column, so build a short human label from the
 * engine + which stages are configured. Mirrors how the routes UI
 * describes a route at a glance.
 */
function describeRouteLabel(route: {
  id: string;
  engine: string;
  filter_expression: string | null;
  transform_script: string | null;
  pipeline_graph: string | null;
}): string {
  const short = route.id.slice(0, 12);
  if (route.pipeline_graph) return `Route ${short} (pipeline)`;
  const parts: string[] = [];
  if (route.filter_expression) parts.push("filter");
  if (route.transform_script) parts.push("transform");
  if (parts.length === 0) return `Route ${short} (passthrough)`;
  return `Route ${short} (${parts.join(" + ")})`;
}
