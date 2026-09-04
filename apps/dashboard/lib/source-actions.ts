"use server";

// Source lifecycle server actions (control-plane API surfaced through the dashboard).

import { db, withTransaction, type Queryable } from "./db";
import { generateSourceToken } from "./source-tokens";
import { RETENTION_BOUNDS } from "./retention-bounds";
import { deploymentCapabilities } from "./deployment-capabilities";
import {
  requireEdgeSourceAuthoritySync,
  requireEdgeSourceFence,
} from "./edge-invalidation";
import { runDashboardPullSync } from "./pull-sync";
import { entityNameError } from "./entity-name";
import {
  validateSubjectKeyPaths,
} from "@axel/shared";
import { withWorkspaceMutation } from "./with-mutation";
import { formValue } from "./form";
import type { ActionState } from "./action-data";

// --- Source lifecycle (control-plane API surfaced through the dashboard) -- //

// requireWritableRole / requireActiveWorkspace / replayBillingGateError now live
// in ./auth-guards so every server-action file applies the same gates.

function _clampInt(input: string | null, fallback: number, max: number): number {
  if (!input) return fallback;
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function _isValidSourceName(name: string): boolean {
  return entityNameError(name) === null;
}

/**
 * Fence hosted authorization, perform the database mutation, then publish a
 * freshly loaded committed source. A failed sync leaves the source fenced.
 */
async function withRequiredSourceAuthorityFence<T>(
  sourceId: string,
  workspaceId: string,
  mutate: () => Promise<T>,
): Promise<T> {
  const fence = await requireEdgeSourceFence(sourceId);
  const result = await mutate();
  await requireEdgeSourceAuthoritySync(fence, workspaceId);
  return result;
}

async function sourceExistsInWorkspace(sourceId: string, workspaceId: string): Promise<boolean> {
  const result = await db().query(
    "SELECT 1 FROM sources WHERE id = $1 AND workspace_id = $2 LIMIT 1",
    [sourceId, workspaceId],
  );
  return (result.rowCount ?? 0) > 0;
}

async function sourceDeletionWasAudited(sourceId: string, workspaceId: string): Promise<boolean> {
  const result = await db().query(
    `SELECT 1
       FROM audit_log
      WHERE workspace_id = $1
        AND target_type = 'source'
        AND target_id = $2
        AND action = 'source.deleted'
      LIMIT 1`,
    [workspaceId, sourceId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * AXE-34 — operator updates the inbound IP allowlist for a source.
 * Parses a textarea of CIDRs (one per line, # comments allowed),
 * validates shape, and writes to DB behind required edge invalidation.
 */
export async function updateSourceIpAllowlistAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source_id." };
    const raw = String(formData.get("allowlist") ?? "");
    // One CIDR per line. Strip blank lines + `#` comments.
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, "").trim())
      .filter((line) => line.length > 0);
    for (const entry of entries) {
      if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/(?:[0-9]|[12][0-9]|3[0-2]))?$/.test(entry)) {
        return { error: `"${entry}" isn't a valid IPv4 CIDR (e.g. 3.18.12.63/32).` };
      }
    }
    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }
    const updated = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const result = await db().query(
        `UPDATE sources SET inbound_ip_allowlist = $1, updated_at = now()
          WHERE id = $2 AND workspace_id = $3`,
        [entries, sourceId, workspaceId],
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.ip_allowlist_updated",
        targetType: "source",
        targetId: sourceId,
        metadata: { entries: entries.length },
      });
      return true;
    });
    if (!updated) return { error: "Source not found in this workspace." };
    tags("sources");
    return {
      notice: entries.length === 0
        ? "Allowlist cleared. Any IP can now reach this source."
        : `Allowlist updated (${entries.length} entr${entries.length === 1 ? "y" : "ies"}). Edge picks it up within a few seconds.`,
    };
  });
}

export async function updateSourceSubjectKeysAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source_id." };

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(formData.get("subject_key_paths") ?? "[]"));
    } catch {
      return { error: "Subject keys were malformed." };
    }
    const result = validateSubjectKeyPaths(parsed);
    if (!result.ok) return { error: result.error };
    const keys = result.value;

    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }

    // Stamp subject_indexing_active_since the first time keys are set — the finder
    // uses it to disclose the pre-config window it cannot cover. Clearing keys
    // does NOT reset it, so events indexed during an earlier active window stay
    // covered. (The fixed SQL fragment is chosen by keys.length, not user input.)
    const value = keys.length > 0 ? JSON.stringify(keys) : null;
    const updated = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const result = await db().query(
        `UPDATE sources
            SET subject_key_paths = $1::jsonb,
                subject_indexing_active_since = ${
                  keys.length > 0 ? "COALESCE(subject_indexing_active_since, now())" : "subject_indexing_active_since"
                },
                updated_at = now()
          WHERE id = $2 AND workspace_id = $3`,
        [value, sourceId, workspaceId],
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.subject_keys_updated",
        targetType: "source",
        targetId: sourceId,
        metadata: { keys: keys.length },
      });
      return true;
    });
    if (!updated) return { error: "Source not found in this workspace." };
    tags("sources");
    return {
      notice: keys.length === 0
        ? "Subject keys cleared. New events won't be indexed for per-subject erasure."
        : `Subject keys saved (${keys.length}). New events are indexed for per-subject erasure within a few seconds.`,
    };
  });
}

export async function triggerPullSourceSync(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, tags }) => {
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source id." };

    try {
      const summary = await runDashboardPullSync({
        sourceId,
        workspaceId,
        actorUserId,
      });
      const records = summary.streams.reduce((sum, stream) => sum + stream.records, 0);
      const streamText = summary.streams
        .map((stream) => `${stream.stream}: ${stream.records}`)
        .join(", ");
      const partial = summary.streams.some((stream) => stream.status === "partial");
      tags("sources");
      return {
        notice: partial
          ? `Sync paused at its page safety limit. Emitted ${records} record${records === 1 ? "" : "s"}${streamText ? ` (${streamText})` : ""}; the continuation was saved for the next run.`
          : `Sync completed. Emitted ${records} record${records === 1 ? "" : "s"}${streamText ? ` (${streamText})` : ""}.`,
        data: { sourceId },
      };
    } catch (err) {
      if (err instanceof Error && err.message === "pull_source_not_found") return { error: "Pull source not found in this workspace." };
      if (err instanceof Error && err.message === "pull_source_disabled") return { error: "Enable this source before syncing." };
      if (err instanceof Error && err.message === "pull_ingest_source_unavailable") return { error: "Enable the source before syncing, or recreate it if it was deleted." };
      if (err instanceof Error && err.message === "pull_sync_already_running") return { error: "This source is already syncing. Try again after the current run finishes." };
      if (err instanceof Error && err.message === "pull_source_type_unsupported") return { error: "Manual sync is not supported for this source type yet." };
      return { error: "Could not run sync." };
    }
  });
}

export async function setSourceStatus(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const sourceId = formValue(formData, "source_id");
    const status = formValue(formData, "status");
    if (!sourceId || (status !== "active" && status !== "disabled")) {
      return { error: "Pick a valid source and a valid status." };
    }
    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }

    const updateStatus = async (client: Queryable) => {
      const result = await client.query(
        `UPDATE sources
            SET status = $1, updated_at = now()
          WHERE id = $2 AND workspace_id = $3`,
        [status, sourceId, workspaceId],
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.status_changed",
        targetType: "source",
        targetId: sourceId,
        metadata: { status },
      }, client);
      return true;
    };
    const outcome = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => (
      status === "disabled"
        ? (await updateStatus(db()) ? "updated" as const : "not_found" as const)
        : withTransaction(async (client) => {
            // Serialize re-enable with workspace suspension/deletion and wipe-time
            // source enumeration. The session liveness check happened before this
            // transaction and can otherwise go stale before the UPDATE.
            const workspace = await client.query<{ status: string }>(
              "SELECT COALESCE(status, 'active') AS status FROM workspaces WHERE id = $1 FOR UPDATE",
              [workspaceId],
            );
            if (workspace.rows[0]?.status !== "active") {
              return "workspace_inactive" as const;
            }
            return await updateStatus(client) ? "updated" as const : "not_found" as const;
          })
    ));
    if (outcome === "workspace_inactive") {
      return { error: "This workspace is no longer active. The source was not enabled." };
    }
    if (outcome === "not_found") return { error: "Source not found in this workspace." };
    tags("sources");
    return {
      notice: status === "active"
        ? "Source enabled. The edge authority is using the committed source state."
        : "Source disabled. The edge authority confirmed the committed disabled state.",
    };
  });
}

export async function rotateSourceToken(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Pick a source to rotate." };
    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }

    const token = generateSourceToken();
    const updated = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const result = await db().query(
        `UPDATE sources
            SET secret_token_hash = $1, updated_at = now()
          WHERE id = $2 AND workspace_id = $3`,
        [token.hash, sourceId, workspaceId],
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.token_rotated",
        targetType: "source",
        targetId: sourceId,
        metadata: {},
      });
      return true;
    });
    if (!updated) return { error: "Source not found in this workspace." };

    tags("sources");

    return {
      notice: "Token rotated. Copy the new token now. It won't be shown again, and the old token is blocked at the edge.",
      data: {
        sourceId,
        plaintextToken: token.plaintext,
      },
    };
  });
}

export async function deleteSource(_state: ActionState, formData: FormData): Promise<ActionState> {
  return withWorkspaceMutation({ role: "any" }, async ({ session, workspaceId, audit, tags }) => {
    // Only owners can hard-delete; admins must use disable.
    if (session.activeWorkspace.role !== "owner") {
      return { error: "Only owners can delete sources. Disable instead if you don't have owner access." };
    }

    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Pick a source to delete." };
    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      // A previous attempt may have committed the delete and then failed its
      // post-delete cache call. The workspace-scoped audit row proves this
      // caller owned the deleted source, allowing a safe idempotent retry
      // without opening cross-tenant cache eviction.
      if (await sourceDeletionWasAudited(sourceId, workspaceId)) {
        const fence = await requireEdgeSourceFence(sourceId);
        await requireEdgeSourceAuthoritySync(fence, workspaceId);
        tags("sources", "routes");
        return { notice: "Source was already deleted. The edge authority now confirms it is absent." };
      }
      return { error: "Source not found in this workspace." };
    }

    // Pull sources share their id with the `sources` shadow row (see
    // createGenericPullSource: pull_sources.id === sources.id). Deleting only the
    // `sources` row left the `pull_sources` row active, so the pull-worker kept
    // syncing + billing a "deleted" source forever (audit: orphan pull source).
    // Delete BOTH in one transaction; the ON DELETE CASCADE FKs on
    // pull_source_credentials / pull_source_stream_state / pull_sync_runs clean up
    // the rest. The pull_sources delete is a no-op for plain webhook sources.
    const deleted = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const removed = await withTransaction(async (client) => {
        const result = await client.query(
          `DELETE FROM sources WHERE id = $1 AND workspace_id = $2`,
          [sourceId, workspaceId],
        );
        if (!result.rowCount) return false;
        await client.query(
          `DELETE FROM pull_sources WHERE id = $1 AND workspace_id = $2`,
          [sourceId, workspaceId],
        );
        await audit({
          action: "source.deleted",
          targetType: "source",
          targetId: sourceId,
          metadata: {},
        }, client);
        return true;
      });
      return removed;
    });
    if (!deleted) return { error: "Source not found in this workspace." };

    tags("sources", "routes");

    return { notice: "Source deleted. Routes attached to it were also removed." };
  });
}

/**
 * Update a source's field selection — the dot-path allowlist that the
 * router projects payloads through before fanning out to destinations.
 *
 * Empty selection (no paths) clears the column → pass-through. Non-empty
 * selection writes the array as jsonb. The action fences authorization and
 * publishes the committed source shape before the edge accepts another event.
 */
export async function updateSourceFieldSelection(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source id." };

    const text = formValue(formData, "selection_text");

    // Lazy-import the parsing helper — it's a pure module so this is just to
    // keep the actions file from owning path-parsing logic.
    const { parseFieldSelectionText } = await import("./field-selection");
    const { paths, errors } = parseFieldSelectionText(text);
    if (errors.length > 0) {
      return { error: `${errors.length} invalid path${errors.length === 1 ? "" : "s"}: ${errors[0]!.message}` };
    }
    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }

    // null when empty so the router code can do `field_selection !== null` to
    // decide whether to project at all.
    const value = paths.length > 0 ? JSON.stringify(paths) : null;

    const updated = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const result = await db().query(
        `UPDATE sources
            SET field_selection = $1::jsonb,
                updated_at = now()
          WHERE id = $2 AND workspace_id = $3`,
        [value, sourceId, workspaceId],
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.field_selection_updated",
        targetType: "source",
        targetId: sourceId,
        metadata: { paths_count: paths.length, paths },
      });
      return true;
    });
    if (!updated) return { error: "Source not found in this workspace." };

    tags("sources");

    return {
      notice:
        paths.length === 0
          ? "Field selection cleared. The router will pass payloads through unchanged."
          : `Field selection saved (${paths.length} path${paths.length === 1 ? "" : "s"}). Takes effect on the next ingest.`,
      data: { sourceId },
    };
  });
}

/**
 * Per-source ingest limits (rate cap, body size, JSON depth).
 *
 * The form submits one of three values for each field:
 *   - empty string → leave existing value untouched (used when only one limit
 *     is being tweaked from a multi-field form)
 *   - "default" → null the column so the worker uses the platform default
 *   - integer string → write the parsed integer (clamped to a sane ceiling)
 *
 * Required cache invalidation makes the worker fetch the new caps from the
 * authenticated control plane instead of serving a stale edge entry.
 */
const SOURCE_LIMIT_CEILINGS = {
  // 1M events/minute = ~16.6k events/sec. Absurd ceiling deliberately — the
  // operator has to opt-in via the dashboard, and we'd rather they not have
  // to file a ticket the first time they hit it.
  maxEventsPerMinute: 1_000_000,
  // 25 MB. Cloudflare's free-tier ingress per request is 100 MB; we cap at
  // 25 MB because R2 multipart-upload costs add up fast above that and most
  // legitimate webhook payloads fit in <1 MB.
  maxBodyBytes: 25 * 1_048_576,
  // 1000-level JSON depth. JSON.parse will reject deeper anyway; this is to
  // bound CPU on pathological payloads.
  maxBodyDepth: 1_000,
} as const;

function parseLimitInput(
  raw: string,
  ceiling: number,
): { kind: "skip" } | { kind: "default" } | { kind: "set"; value: number } | { kind: "error"; message: string } {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "skip" };
  if (trimmed.toLowerCase() === "default") return { kind: "default" };
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(value) || value <= 0) {
    return { kind: "error", message: "Must be a positive integer or 'default'." };
  }
  if (value > ceiling) {
    return { kind: "error", message: `Exceeds ceiling of ${ceiling.toLocaleString()}.` };
  }
  return { kind: "set", value };
}

export async function updateSourceLimits(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source id." };

    const rate = parseLimitInput(formValue(formData, "max_events_per_minute"), SOURCE_LIMIT_CEILINGS.maxEventsPerMinute);
    if (rate.kind === "error") return { error: `Rate cap: ${rate.message}` };
    const body = parseLimitInput(formValue(formData, "max_body_bytes"), SOURCE_LIMIT_CEILINGS.maxBodyBytes);
    if (body.kind === "error") return { error: `Max body size: ${body.message}` };
    const depth = parseLimitInput(formValue(formData, "max_body_depth"), SOURCE_LIMIT_CEILINGS.maxBodyDepth);
    if (depth.kind === "error") return { error: `Max JSON depth: ${depth.message}` };

    // Build the dynamic SET clause so we only touch columns the form actually
    // intended to change. parameterised, no string concatenation of values.
    const setParts: string[] = [];
    const values: (number | string | null)[] = [];
    let pIdx = 1;
    function applyClause(column: string, parsed: ReturnType<typeof parseLimitInput>) {
      if (parsed.kind === "skip") return;
      if (parsed.kind === "default") {
        setParts.push(`${column} = NULL`);
        return;
      }
      if (parsed.kind === "set") {
        setParts.push(`${column} = $${pIdx++}`);
        values.push(parsed.value);
      }
    }
    applyClause("max_events_per_minute", rate);
    applyClause("max_body_bytes", body);
    applyClause("max_body_depth", depth);

    if (setParts.length === 0) {
      return { error: "No changes — leave a field blank to keep its current value, type 'default' to revert to platform default." };
    }

    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }

    setParts.push(`updated_at = now()`);
    values.push(sourceId);
    values.push(workspaceId);

    const updated = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const result = await db().query(
        `UPDATE sources SET ${setParts.join(", ")} WHERE id = $${pIdx++} AND workspace_id = $${pIdx++}`,
        values,
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.limits_updated",
        targetType: "source",
        targetId: sourceId,
        metadata: {
          max_events_per_minute: rate.kind === "set" ? rate.value : rate.kind,
          max_body_bytes: body.kind === "set" ? body.value : body.kind,
          max_body_depth: depth.kind === "set" ? depth.value : depth.kind,
        },
      });
      return true;
    });
    if (!updated) return { error: "Source not found in this workspace." };

    tags("sources");

    // Build a human summary of what changed for the success toast.
    const changes: string[] = [];
    if (rate.kind === "set") changes.push(`rate cap → ${rate.value.toLocaleString()}/min`);
    if (rate.kind === "default") changes.push("rate cap → default");
    if (body.kind === "set") changes.push(`max body → ${body.value.toLocaleString()} bytes`);
    if (body.kind === "default") changes.push("max body → default");
    if (depth.kind === "set") changes.push(`max depth → ${depth.value}`);
    if (depth.kind === "default") changes.push("max depth → default");

    return {
      notice: `Limits updated: ${changes.join(", ")}. The edge authority is using the committed caps.`,
      data: { sourceId },
    };
  });
}

/**
 * AXE-35 — per-source transient mode + raw_payload retention
 * override. Transient mode is a shortcut for
 * `raw_payload_retention_days = 0` and disables replay for the source
 * (the UI hides replay when it's on).
 *
 * The effective raw retention (override ?? workspace default) is enforced
 * on the R2 bytes by the delivery-service sweep (r2-retention.ts), which
 * deletes raw payloads early for sub-30-day values. A short safety floor
 * (RAW_RETENTION_MIN_AGE_DAYS) means transient (0) clears within a few
 * days of delivery, not instantly — so an in-flight retry can still fetch
 * its body. Values >= 30 are left to the fixed R2 lifecycle rule.
 */
export async function updateSourceTransientModeAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit, tags }) => {
    if (!deploymentCapabilities().configurableRawPayloadRetention) {
      return {
        error: "Transient mode and per-source raw retention are unavailable in the small self-host profile.",
      };
    }
    const sourceId = formValue(formData, "source_id");
    if (!sourceId) return { error: "Missing source_id." };
    const transientMode = formValue(formData, "transient_mode") === "on";
    const rawOverrideRaw = formValue(formData, "raw_payload_retention_days");
    let rawOverride: number | null = null;
    if (rawOverrideRaw) {
      const { min, max } = RETENTION_BOUNDS.raw_payload_retention_days;
      const n = Number(rawOverrideRaw);
      if (!Number.isInteger(n) || n < min || n > max) {
        return { error: `Raw payload retention override must be ${min} – ${max} days, or empty to inherit workspace default.` };
      }
      rawOverride = n;
    }
    if (!await sourceExistsInWorkspace(sourceId, workspaceId)) {
      return { error: "Source not found in this workspace." };
    }
    const updated = await withRequiredSourceAuthorityFence(sourceId, workspaceId, async () => {
      const result = await db().query(
        `UPDATE sources
            SET transient_mode = $3,
                raw_payload_retention_days = $4,
                updated_at = now()
          WHERE id = $1 AND workspace_id = $2`,
        [sourceId, workspaceId, transientMode, transientMode ? 0 : rawOverride],
      );
      if (!result.rowCount) return false;
      await audit({
        action: "source.transient_mode_updated",
        targetType: "source",
        targetId: sourceId,
        metadata: { transient_mode: transientMode, raw_override: rawOverride },
      });
      return true;
    });
    if (!updated) return { error: "Source not found in this workspace." };
    tags("sources");
    return {
      notice: transientMode
        ? "Transient mode ON. New events route as before and replay is disabled for this source. Raw payloads are purged early — within a few days of delivery rather than the 30-day default."
        : rawOverride !== null
        ? `Raw payload retention override set to ${rawOverride} days.`
        : "Raw payload retention reset to workspace default.",
    };
  });
}
