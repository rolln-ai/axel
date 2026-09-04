"use server";

// Danger-zone server actions: destructive workspace/destination data resets.

import { redirect } from "next/navigation";
import { withTransaction } from "./db";
import { bustWorkspaceTags } from "./repositories";
import { setActiveWorkspaceId } from "./session";
import {
  requireEdgeSourceAuthoritySyncs,
  requireEdgeSourceFences,
} from "./edge-invalidation";
import { withWorkspaceMutation } from "./with-mutation";
import { flushAllDestinationData, flushDestinationData, wipeWorkspaceData } from "./data-reset";
import { formValue } from "./form";
import type { ActionState } from "./action-data";

export async function wipeWorkspaceSystemData(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    if (session.activeWorkspace.role !== "owner") {
      return { error: "Only workspace owners can wipe event data." };
    }
    const confirmation = formValue(formData, "confirmation");
    if (confirmation.toLowerCase() !== "wipe") {
      return { error: 'Type "wipe" to confirm.' };
    }

    const includeRawPayloads = formData.get("include_raw_payloads") === "on";
    try {
      const result = await wipeWorkspaceData(workspaceId, { includeRawPayloads });
      await audit({
        action: "workspace.event_data_wiped",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: {
          clickhouse_tables: result.clickhouseTables,
          postgres_rows: result.postgresRows,
          r2_deleted: result.r2Deleted,
          r2_skipped: result.r2Skipped,
          r2_limit_reached: result.r2LimitReached,
          postgres_limit_reached: result.postgresLimitReached,
          clickhouse_limit_reached: result.clickhouseLimitReached,
        },
      });
      bustWorkspaceTags(workspaceId);
      const r2Text = includeRawPayloads
        ? result.r2Skipped
          ? " Raw R2 payload deletion was skipped because Cloudflare credentials are not configured."
          : ` Deleted ${result.r2Deleted} raw R2 payload${result.r2Deleted === 1 ? "" : "s"}.`
        : "";
      const limitText = result.r2LimitReached || result.postgresLimitReached || result.clickhouseLimitReached
        ? " More workspace data remains; run the wipe again to resume the bounded cleanup pass."
        : "";
      return {
        notice: `Workspace event data wipe pass completed. Advanced ClickHouse cleanup for: ${result.clickhouseTables.join(", ") || "none"}. Removed ${result.postgresRows} operational row${result.postgresRows === 1 ? "" : "s"}.${r2Text}${limitText}`,
      };
    } catch {
      return { error: "Could not wipe workspace event data." };
    }
  });
}

export async function flushDestinationTargetData(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    if (session.activeWorkspace.role !== "owner") {
      return { error: "Only workspace owners can flush destination data." };
    }
    const destinationId = formValue(formData, "destination_id");
    const confirmation = formValue(formData, "destination_confirmation");
    if (!destinationId) return { error: "Choose a destination to flush." };
    if (confirmation.toLowerCase() !== "flush") {
      return { error: 'Type "flush" to confirm.' };
    }

    try {
      const result = await flushDestinationData(workspaceId, destinationId);
      await audit({
        action: "destination.target_data_flushed",
        targetType: "destination",
        targetId: destinationId,
        metadata: { type: result.type, detail: result.detail },
      });
      bustWorkspaceTags(workspaceId);
      return { notice: result.detail };
    } catch {
      return { error: "Could not flush destination data." };
    }
  });
}

export async function wipeAllWorkspaceData(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    if (session.activeWorkspace.role !== "owner") {
      return { error: "Only workspace owners can wipe all data." };
    }

    const confirmation = formValue(formData, "confirmation");
    if (confirmation.toLowerCase() !== "wipe all") {
      return { error: 'Type "wipe all" to confirm.' };
    }
    const pauseSources = formData.get("pause_sources") !== "off";
    try {
      const pausedSources = pauseSources ? await pauseWorkspaceSources(workspaceId) : 0;
      const targetResult = await flushAllDestinationData(workspaceId);
      const axelResult = await wipeWorkspaceData(workspaceId, { includeRawPayloads: true });

      await audit({
        action: "workspace.all_event_data_wiped",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: {
          axel: {
            clickhouse_tables: axelResult.clickhouseTables,
            postgres_rows: axelResult.postgresRows,
            r2_deleted: axelResult.r2Deleted,
            r2_skipped: axelResult.r2Skipped,
            r2_limit_reached: axelResult.r2LimitReached,
            postgres_limit_reached: axelResult.postgresLimitReached,
            clickhouse_limit_reached: axelResult.clickhouseLimitReached,
          },
          paused_sources: pausedSources,
          destinations: {
            attempted: targetResult.attempted,
            flushed: targetResult.flushed.map((item) => ({ destination_id: item.destinationId, type: item.type, detail: item.detail })),
            skipped: targetResult.skipped.map((item) => ({ destination_id: item.id, type: item.type, detail: item.detail })),
            failed: targetResult.failed,
          },
        },
      });
      bustWorkspaceTags(workspaceId);

      const failedText = targetResult.failed.length > 0
        ? ` ${targetResult.failed.length} destination flush${targetResult.failed.length === 1 ? "" : "es"} failed; unsupported targets were skipped.`
        : "";
      const r2Text = axelResult.r2Skipped
        ? " Raw R2 payload deletion was skipped because Cloudflare credentials are not configured."
        : ` Deleted ${axelResult.r2Deleted} raw R2 payload${axelResult.r2Deleted === 1 ? "" : "s"}.`;
      const pauseText = pausedSources > 0
        ? ` Paused ${pausedSources} source${pausedSources === 1 ? "" : "s"} before wiping to stop new ingest.`
        : "";
      const pendingText = axelResult.r2LimitReached || axelResult.postgresLimitReached || axelResult.clickhouseLimitReached
        ? " More Axel-owned data remains; run the wipe again to resume the bounded cleanup pass."
        : "";
      return {
        notice: `Wipe pass completed and flushed ${targetResult.flushed.length} target destination${targetResult.flushed.length === 1 ? "" : "s"}.${pauseText}${r2Text}${pendingText}${failedText}`,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "workspace_not_active") {
        return { error: "workspace_not_active" };
      }
      return { error: "Could not wipe all data." };
    }
  });
}

/**
 * Schedule permanent deletion of the active workspace.
 *
 * Two-phase so the UI stays snappy and we never hold a request open through a
 * multi-minute teardown:
 *   1. HERE (synchronous, fast): re-verify the typed name under a row lock,
 *      write the audit row, flip status → 'deleting', and pause the workspace's
 *      sources at the edge so NO new webhooks land while teardown runs. Then
 *      redirect the user to another active workspace (or /welcome). A 'deleting'
 *      workspace is non-writable (assertWorkspaceWritable) and hidden from the
 *      switcher (getCurrentSession), so it's effectively gone from the user's POV.
 *   2. LATER (workspace-teardown cron, lib/workspace-teardown.ts): flush final
 *      Stripe usage → cancel the subscription with a final invoice → wipe the
 *      non-cascading external stores (ClickHouse rows + R2 raw payloads) → hard
 *      DELETE the row (FK cascade clears sources/routes/destinations/etc.) and
 *      reap the FK-less workspace-scoped tables. Every step is idempotent, so a
 *      timeout on a huge workspace just resumes on the next sweep.
 *
 * This does NOT flush external destination systems (the user's own Postgres /
 * Mongo / Databricks tables) — that data lives in systems Axel doesn't own.
 * Use "Wipe all data" for that.
 */
export async function deleteCurrentWorkspace(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit }) => {
    if (session.activeWorkspace.role !== "owner") {
      return { error: "Only workspace owners can delete a workspace." };
    }
    const workspaceName = session.activeWorkspace.workspace_name;
    const typedName = formValue(formData, "confirm_name");
    if (!typedName) return { error: "Type the workspace name to confirm." };
    if (typedName !== workspaceName) {
      return { error: "Typed name does not match the workspace name." };
    }

    // Two-phase delete: flip the workspace to 'deleting' (instant) and let the
    // workspace-teardown cron do the heavy lifting out of band — thousands of R2
    // object deletes + synchronous ClickHouse mutations + the Stripe cancellation.
    // Running that inline hung the UI for minutes and could exceed the 300s
    // function limit, leaving a half-wiped shell. See lib/workspace-teardown.ts.
    try {
      const sourceFences = await withTransaction(async (client) => {
        // Lock + re-verify under the lock so concurrent deletes / double-clicks /
        // server-action retries serialize instead of double-scheduling.
        const wsRow = await client.query<{ name: string; status: string }>(
          "SELECT name, COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
          [workspaceId],
        );
        const row = wsRow.rows[0];
        if (!row) return []; // already gone (a concurrent delete won) — fall through to redirect
        if (row.status === "deleting") {
          const sources = await client.query<{ id: string }>(
            "SELECT id FROM sources WHERE workspace_id = $1",
            [workspaceId],
          );
          return requireEdgeSourceFences(sources.rows.map((source) => source.id));
        }
        if (row.name !== typedName) throw new Error("name_mismatch");

        const sources = await client.query<{ id: string }>(
          "SELECT id FROM sources WHERE workspace_id = $1",
          [workspaceId],
        );
        const ids = sources.rows.map((source) => source.id);
        const fences = await requireEdgeSourceFences(ids);

        // Audit row written while workspace_id is still a live FK target; the
        // eventual hard DELETE in teardown SET NULLs it but the row survives.
        // Record the impersonator (if any) so a destructive op performed by a
        // super-admin "viewing as" the owner is attributable to the real actor.
        await audit({
          action: "workspace.deleted",
          targetType: "workspace",
          targetId: workspaceId,
          metadata: {
            name: workspaceName,
            impersonator_user_id: session.impersonator?.id ?? null,
          },
        }, client);
        await client.query(
          "UPDATE workspaces SET status = 'deleting', deleted_at = now() WHERE id = $1",
          [workspaceId],
        );
        await client.query(
          `UPDATE sources SET status = 'disabled', updated_at = now()
            WHERE workspace_id = $1 AND status <> 'disabled'`,
          [workspaceId],
        );
        return fences;
      });

      await requireEdgeSourceAuthoritySyncs(sourceFences, workspaceId);
      bustWorkspaceTags(workspaceId);
    } catch (err) {
      if (err instanceof Error && err.message === "name_mismatch") {
        return { error: "Typed name does not match the workspace name." };
      }
      console.error("[deleteCurrentWorkspace] failed to schedule teardown");
      return { error: "Could not delete the workspace." };
    }

    // Move the user somewhere valid: another ACTIVE workspace they belong to, or
    // the onboarding screen if none remain. (A suspended-only remainder lands on
    // /welcome rather than a dead suspended banner.)
    const target = session.memberships.find(
      (m) => m.workspace_id !== workspaceId && m.workspace_status === "active",
    );
    if (target) {
      await setActiveWorkspaceId(target.workspace_id);
      redirect("/dashboard");
    }
    redirect("/welcome");
  });
}

async function pauseWorkspaceSources(workspaceId: string): Promise<number> {
  const result = await withTransaction(async (client) => {
    // Take the same row lock used by source creation/re-enable. This prevents a
    // concurrent active source from landing between enumeration and disable.
    const workspace = await client.query<{ status: string }>(
      "SELECT COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
      [workspaceId],
    );
    if (workspace.rows[0]?.status !== "active") {
      throw new Error("workspace_not_active");
    }
    const sources = await client.query<{ id: string }>(
      "SELECT id FROM sources WHERE workspace_id = $1",
      [workspaceId],
    );
    const ids = sources.rows.map((source) => source.id);
    const fences = await requireEdgeSourceFences(ids);
    const updated = await client.query(
      `UPDATE sources
          SET status = 'disabled', updated_at = now()
        WHERE workspace_id = $1 AND status <> 'disabled'
        RETURNING id`,
      [workspaceId],
    );
    return { fences, pausedCount: updated.rowCount ?? 0 };
  });
  await requireEdgeSourceAuthoritySyncs(result.fences, workspaceId);
  return result.pausedCount;
}
