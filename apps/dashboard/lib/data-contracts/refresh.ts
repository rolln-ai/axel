"use server";

/**
 * Manual "Refresh now" for a Data Contract (dashboard button), companion
 * to the auto-extend cron in drift.ts.
 *
 * Why a separate path: autoExtendIfNeeded only fires when drift
 * detection has just inserted a `new_event_type` row, and only runs
 * against ACTIVE maps via the cron. Operators want a one-click
 * "I just sent something new, look for it" affordance that:
 *   - Works on draft maps too (the cron skips drafts).
 *   - Bypasses the drift insertion gate (operator already knows
 *     they sent a new event; don't make them wait for a drift row).
 *
 * Implementation: re-sample → re-infer → diff against the current
 * version's clusters → if anything's new, append a new version
 * carrying the broader schema. Field annotations / generated
 * artifacts / destination mapping are carried forward, exactly like
 * autoExtendIfNeeded does, so the routing pipeline doesn't get
 * blown up.
 */

import { revalidatePath } from "next/cache";
import { db } from "../db";
import { requireSession } from "../session";
import { requireActiveWorkspace, requireWritableRole } from "../auth-guards";
import { sampleSourceEventsPreferIndex, SamplerPayloadFetchError } from "./sampler";
import { appendDataContractVersion } from "./repository";
import { inferDeterministic, type InferredDataContract } from "./inference";
import { writeAudit } from "../audit";
import type { ActionState as ActionStateBase } from "../action-state";

export type ActionState = ActionStateBase<{
  added_clusters?: string[];
  new_version_id?: string;
}>;

interface MapRow {
  id: string;
  name: string;
  workspace_id: string;
  source_id: string;
  current_version_id: string | null;
}

interface VersionRow {
  id: string;
  inferred_schema: InferredDataContract;
  field_annotations: Record<string, unknown>;
  generated_filter: string | null;
  generated_transform: string | null;
  transform_language: "jsonata" | "js" | null;
  destination_mapping: Record<string, unknown> | null;
  model_metadata: Record<string, unknown>;
}

export async function refreshDataContractNow(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSession();
  // Refresh re-samples and appends a new version — a mutation. Gate it with
  // the SHARED owner/admin + active-workspace guards like every other Data
  // Contract mutation (audit: this action only checked requireSession,
  // letting any member append versions).
  const roleError = requireWritableRole(session.activeWorkspace.role);
  if (roleError) return { error: roleError };
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return { error: wsError };
  const dataContractId = String(formData.get("data_contract_id") ?? "").trim();
  if (!dataContractId) return { error: "data_contract_id is required." };

  const mapRes = await db().query<MapRow>(
    `SELECT id, name, workspace_id, source_id, current_version_id
       FROM data_contracts
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [dataContractId, session.activeWorkspace.workspace_id],
  );
  const map = mapRes.rows[0];
  if (!map) return { error: "Data Contract not found in this workspace." };
  if (!map.current_version_id) {
    return { error: "Data Contract has no current version yet — open the map and run codegen first." };
  }

  const versionRes = await db().query<VersionRow>(
    `SELECT id, inferred_schema, field_annotations, generated_filter,
            generated_transform, transform_language, destination_mapping,
            model_metadata
       FROM data_contract_versions
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [map.current_version_id, map.workspace_id],
  );
  const currentVersion = versionRes.rows[0];
  if (!currentVersion) return { error: "Current version row missing — that's a bug, please report." };

  // Re-sample. Prefer the exhaustive event-type index — it returns one
  // bounded slice per DISTINCT type, so even a long tail of sub-1% types is
  // guaranteed to show up (exactly the "Refresh now" intent). Falls back to
  // the 200-event random sampler for sources whose events predate the
  // event_type index (un-backfilled) or carry no discriminator.
  let samples: Awaited<ReturnType<typeof sampleSourceEventsPreferIndex>>;
  try {
    samples = await sampleSourceEventsPreferIndex(map.workspace_id, map.source_id, {
      maxEvents: 200,
    });
  } catch (err: unknown) {
    if (err instanceof SamplerPayloadFetchError) {
      // R2 unreachable — the event metadata IS in ClickHouse but the
      // payload store can't be read. Tell the operator exactly what to
      // check rather than the generic "no events" notice they'd get if
      // we papered over this.
      return { error: err.message };
    }
    return {
      error: `Couldn't fetch recent events: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (samples.length === 0) {
    return {
      notice:
        "No recent events to sample yet. Send a few events to this source, then click Refresh again.",
    };
  }

  const next = inferDeterministic(samples);
  const knownClusterIds = new Set(
    (currentVersion.inferred_schema.event_types ?? []).map((c) => c.cluster_id),
  );
  const addedClusters = next.event_types
    .filter((c) => !knownClusterIds.has(c.cluster_id))
    .map((c) => c.name);

  if (addedClusters.length === 0) {
    revalidatePath(`/data-contracts/${dataContractId}`);
    return {
      notice: `No new event types found across ${samples.length} sampled events. Map already covers everything.`,
    };
  }

  // The append can still fail (db hiccup, or a concurrent refresh from the
  // drift cron / another tab committing first). Surface that as an inline
  // action error instead of letting it propagate as an unhandled server-action
  // throw — which would replace the whole contract detail page with the
  // generic error boundary.
  let newVersion: Awaited<ReturnType<typeof appendDataContractVersion>>;
  try {
    newVersion = await appendDataContractVersion({
      dataContractId: map.id,
      workspaceId: map.workspace_id,
      inferredSchema: next,
      fieldAnnotations: currentVersion.field_annotations,
      generatedFilter: currentVersion.generated_filter,
      generatedTransform: currentVersion.generated_transform,
      transformLanguage: currentVersion.transform_language,
      destinationMapping: currentVersion.destination_mapping,
      modelMetadata: {
        ...currentVersion.model_metadata,
        manually_extended_at: new Date().toISOString(),
        manually_extended_from_version_id: currentVersion.id,
        manually_extended_by_user_id: session.user.id,
        added_clusters: addedClusters,
      },
      createdByUserId: session.user.id,
    });
  } catch (err: unknown) {
    revalidatePath(`/data-contracts/${dataContractId}`);
    return {
      error: `Couldn't save the refreshed version — another refresh may have just landed. Reload the page and try again if the new event types aren't there. (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  try {
    await writeAudit(db(), {
      workspaceId: map.workspace_id,
      actorUserId: session.user.id,
      action: "data_contract.manually_extended",
      targetType: "data_contract",
      targetId: map.id,
      metadata: {
        new_version_id: newVersion.id,
        added_clusters: addedClusters,
        sample_size: samples.length,
      },
    });
  } catch (err) {
    // Audit soft-fail: the version is already committed, so don't convert a
    // logging hiccup into a user-facing error (they'd retry and append again).
    console.error("[data-contracts] refresh audit_log insert failed:", err);
  }

  revalidatePath(`/data-contracts/${dataContractId}`);
  return {
    notice: `Added ${addedClusters.length} new event type${addedClusters.length === 1 ? "" : "s"}: ${addedClusters.map((c) => `"${c}"`).join(", ")}.`,
    data: { added_clusters: addedClusters, new_version_id: newVersion.id },
  };
}
