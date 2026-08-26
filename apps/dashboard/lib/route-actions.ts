"use server";

// Route lifecycle server actions: backfill, status, rename, destinations, delete.

import { db, withTransaction } from "./db";
import {
  PIPELINE_BINDING_REQUIRED,
  prepareBigQueryBindingForEdit,
  parseBindingFromForm,
} from "./pipeline-binding";
import { type DestinationType } from "./destination-defaults";
import { entityNameError } from "./entity-name";
import { cancelBackfillJob as cancelBackfillJobRow, createBackfillJob } from "./backfill-jobs";
import { withWorkspaceMutation } from "./with-mutation";
import { formValue } from "./form";
import type { ActionState } from "./action-data";

// --- Route lifecycle ------------------------------------------------------ //

/**
 * AXE-66 — Queue an async backfill job for an existing route. Use this
 * when the operator wired the route earlier (e.g. before the destination
 * was ready) and now wants to flush captured history into it. The
 * delivery-service worker drains the job in throttled batches; the UI
 * shows progress on the route detail page.
 */
export async function backfillRoute(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, tags }) => {
    const routeId = formValue(formData, "route_id");
    if (!routeId) return { error: "Missing route_id." };
    const daysRaw = formValue(formData, "backfill_days");
    const days = daysRaw ? Number.parseInt(daysRaw, 10) : 0;
    if (!Number.isFinite(days) || days <= 0) {
      return { error: "Pick a backfill window (1–30 days)." };
    }
    const cappedDays = Math.min(days, 30);

    // Confirm the route belongs to this workspace and grab its source_id.
    const routeResult = await db().query<{ source_id: string }>(
      `SELECT source_id FROM routes WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [routeId, workspaceId],
    );
    const route = routeResult.rows[0];
    if (!route) return { error: "Route not found in this workspace." };

    const until = new Date();
    const since = new Date(until.getTime() - cappedDays * 86_400_000);

    try {
      const job = await createBackfillJob({
        workspaceId,
        routeId,
        sourceId: route.source_id,
        since,
        until,
        requestedByUserId: actorUserId,
      });
      tags("routes");
      const sizePhrase = job.total_estimated > 0
        ? `${job.total_estimated.toLocaleString()} event${job.total_estimated === 1 ? "" : "s"} estimated`
        : "size estimate unavailable";
      return {
        notice: `Backfill job queued (${sizePhrase}). The worker drains it in throttled batches — track progress on this page.`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      return { error: `Could not queue backfill job (${reason}).` };
    }
  });
}

/**
 * AXE-66 — Cancel an in-flight backfill job. Already-enqueued replays
 * continue draining (the worker just stops enqueueing more).
 */
export async function cancelBackfillJob(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, tags }) => {
    const jobId = formValue(formData, "job_id");
    if (!jobId) return { error: "Missing job_id." };

    const cancelled = await cancelBackfillJobRow(
      workspaceId,
      jobId,
      actorUserId,
    );
    if (!cancelled) {
      return { error: "Job not found or already finished." };
    }
    tags("routes");
    return {
      notice: "Backfill cancelled. Replays already enqueued will continue to deliver.",
    };
  });
}

export async function setRouteStatus(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const routeId = formValue(formData, "route_id");
    const status = formValue(formData, "status");
    if (!routeId || (status !== "active" && status !== "disabled")) {
      return { error: "Pick a valid route and a valid status." };
    }

    const result = await db().query(
      `UPDATE routes SET status = $1, updated_at = now()
        WHERE id = $2 AND workspace_id = $3`,
      [status, routeId, workspaceId],
    );
    if (!result.rowCount) return { error: "Route not found in this workspace." };
    await audit({
      action: "route.status_changed",
      targetType: "route",
      targetId: routeId,
      metadata: { status },
    });
    tags("routes");
    return { notice: `Route ${status === "active" ? "enabled" : "disabled"}.` };
  });
}

export async function renameRoute(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const routeId = formValue(formData, "route_id");
    const name = formValue(formData, "name").trim();
    if (!routeId) return { error: "Pick a pipeline to rename." };
    if (!name) return { error: "Enter a pipeline name." };
    const nameErr = entityNameError(name);
    if (nameErr) return { error: nameErr };

    const result = await db().query(
      `UPDATE routes SET name = $1, updated_at = now()
        WHERE id = $2 AND workspace_id = $3`,
      [name, routeId, workspaceId],
    );
    if (!result.rowCount) return { error: "Pipeline not found in this workspace." };
    await audit({
      action: "route.renamed",
      targetType: "route",
      targetId: routeId,
      metadata: { name },
    });
    tags("routes");
    return { notice: `Pipeline renamed to "${name}".` };
  });
}

export async function updateRouteDestinations(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const routeId = formValue(formData, "route_id");
    if (!routeId) return { error: "Pick a route to update." };

    const destinationIds = Array.from(
      new Set(
        formData
          .getAll("destination_ids")
          .filter((v): v is string => typeof v === "string" && v.length > 0),
      ),
    );
    if (destinationIds.length === 0) return { error: "Pick at least one destination." };

    try {
      await withTransaction(async (client) => {
        const routeCheck = await client.query<{ pipeline_graph: string | null }>(
          `SELECT pipeline_graph FROM routes WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
          [routeId, workspaceId],
        );
        if (!routeCheck.rowCount) throw new Error("route_not_found");
        // A DAG (pipeline_graph) route's destination nodes are validated by the
        // router against the attached set; rewriting route_destinations here without
        // rewriting the graph would leave a node referencing a now-detached
        // destination, and the router dead-letters 100% of the route's traffic with
        // graph_destination_not_attached. This flat editor is for legacy fan-out
        // routes only — refuse pipeline routes (they're managed via the pipeline
        // editor / recreate) rather than silently corrupting the topology.
        if (routeCheck.rows[0]?.pipeline_graph != null) {
          throw new Error("pipeline_route_destinations_immutable");
        }

        const dests = await client.query<{ id: string; type: string }>(
          `SELECT id, type
             FROM destinations
            WHERE workspace_id = $1 AND id = ANY($2::text[])`,
          [workspaceId, destinationIds],
        );
        if (dests.rowCount !== destinationIds.length) {
          throw new Error("destination_not_found");
        }
        const destTypeById = new Map(dests.rows.map((d) => [d.id, d.type]));

        const existing = await client.query<{ destination_id: string; binding: unknown }>(
          `SELECT destination_id, binding
             FROM route_destinations
            WHERE route_id = $1
            FOR UPDATE`,
          [routeId],
        );
        const before = existing.rows.map((row) => row.destination_id);
        const previousBindingByDestinationId = new Map(
          existing.rows.map((row) => [row.destination_id, row.binding] as const),
        );

        await client.query(`DELETE FROM route_destinations WHERE route_id = $1`, [routeId]);
        for (const destinationId of destinationIds) {
          let binding = parseBindingFromForm(formData, destinationId);
          if (binding && destTypeById.get(destinationId) === "bigquery") {
            const prepared = prepareBigQueryBindingForEdit(
              binding,
              previousBindingByDestinationId.get(destinationId),
            );
            if ("error" in prepared) throw new Error(prepared.error);
            binding = prepared.binding;
          }
          // Same binding guard as createRoute — a postgres/mongodb/databricks
          // destination with no target binding dead-letters every delivery.
          if (!binding && PIPELINE_BINDING_REQUIRED.has(destTypeById.get(destinationId) as DestinationType)) {
            throw new Error("missing_binding");
          }
          await client.query(
            `INSERT INTO route_destinations (route_id, destination_id, binding) VALUES ($1, $2, $3)`,
            [routeId, destinationId, binding ? JSON.stringify(binding) : null],
          );
        }
        await client.query(
          `UPDATE routes SET updated_at = now() WHERE id = $1 AND workspace_id = $2`,
          [routeId, workspaceId],
        );
        await audit({
          action: "route.destinations_updated",
          targetType: "route",
          targetId: routeId,
          metadata: {
            before,
            after: destinationIds,
            destination_count: destinationIds.length,
          },
        }, client);
      });
    } catch (err) {
      if (err instanceof Error && err.message === "route_not_found") {
        return { error: "Route not found in this workspace." };
      }
      if (err instanceof Error && err.message === "destination_not_found") {
        return { error: "One or more destinations weren't found in this workspace." };
      }
      if (err instanceof Error && err.message === "pipeline_route_destinations_immutable") {
        return { error: "This route uses a pipeline graph — edit its destinations in the pipeline editor (or recreate the route). Changing them here would break delivery." };
      }
      if (err instanceof Error && err.message === "nested_requires_new_table") {
        return {
          error: "Nested BigQuery mode needs a different new/empty table or a compatible existing RECORD table when converting a flat or raw binding. The old table is preserved for rollback.",
        };
      }
      if (err instanceof Error && err.message === "invalid_bigquery_table") {
        return { error: "Use a BigQuery target in dataset.table format (letters, numbers, underscores; table names may also contain hyphens)." };
      }
      if (err instanceof Error && err.message === "invalid_bigquery_dataset") {
        return { error: "Use a BigQuery dataset containing only letters, numbers, or underscores (up to 1,024 characters)." };
      }
      if (err instanceof Error && err.message === "missing_bigquery_dataset") {
        return { error: "Choose a BigQuery target in dataset.table format." };
      }
      if (err instanceof Error && err.message === "missing_binding") {
        return { error: "Pick a target table or collection for each BigQuery, Postgres, MongoDB, or Databricks destination — without one, every delivery would fail." };
      }
      return { error: "Could not update route destinations. Try again." };
    }

    tags("routes");
    return { notice: `Route destinations updated. ${destinationIds.length} destination(s) attached.` };
  });
}

export async function deleteRoute(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit, tags }) => {
    if (session.activeWorkspace.role !== "owner") {
      return { error: "Only owners can delete routes. Disable instead." };
    }
    const routeId = formValue(formData, "route_id");
    if (!routeId) return { error: "Pick a route to delete." };

    const result = await db().query(
      `DELETE FROM routes WHERE id = $1 AND workspace_id = $2`,
      [routeId, workspaceId],
    );
    if (!result.rowCount) return { error: "Route not found in this workspace." };
    await audit({
      action: "route.deleted",
      targetType: "route",
      targetId: routeId,
      metadata: {},
    });
    tags("routes");
    return { notice: "Route deleted." };
  });
}
