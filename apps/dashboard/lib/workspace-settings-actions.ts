"use server";

// Workspace settings server actions: retention, search, API keys.

import { revalidatePath } from "next/cache";
import { db } from "./db";
import { RETENTION_BOUNDS } from "./retention-bounds";
import { withWorkspaceMutation } from "./with-mutation";
import { formValue } from "./form";
import type { ActionState } from "./action-data";
import { deploymentCapabilities } from "./deployment-capabilities";

/**
 * AXE-35 — workspace-level retention. Operator-tunable caps on how
 * long dead-letters / replay / audit rows live before the
 * delivery-service's hourly cleanup loop purges them.
 *
 * Bounds come from RETENTION_BOUNDS (./retention-bounds) — the single
 * source of truth shared with the form, kept in lockstep with the CHECK
 * constraints in migration 0048 so the form never submits a value the DB
 * will reject. (raw_payload is capped at 30 to match the R2 lifecycle
 * ceiling; sub-30 values ARE enforced on the bytes by the delivery-service
 * R2 sweep, down to a short safety floor — see the panel hint.)
 */
export async function updateWorkspaceRetentionAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    if (
      !deploymentCapabilities().configurableRawPayloadRetention
      && formData.has("raw_payload_retention_days")
    ) {
      return {
        error: "Raw payload retention is fixed at 30 days in the small self-host profile.",
      };
    }
    const fields = [
      { key: "raw_payload_retention_days", label: "Raw payload" },
      { key: "dead_letter_retention_days", label: "Dead letter" },
      { key: "replay_request_retention_days", label: "Replay request" },
      { key: "audit_log_retention_days", label: "Audit log" },
    ] as const;
    const updates: Record<string, number> = {};
    for (const f of fields) {
      const raw = formValue(formData, f.key);
      if (!raw) continue;
      const { min, max } = RETENTION_BOUNDS[f.key];
      const n = Number(raw);
      if (!Number.isInteger(n) || n < min || n > max) {
        return { error: `${f.label} retention must be an integer between ${min} and ${max} days.` };
      }
      updates[f.key] = n;
    }
    if (Object.keys(updates).length === 0) return { error: "No changes to apply." };
    const setSql = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = [workspaceId, ...Object.values(updates)];
    try {
      await db().query(`UPDATE workspaces SET ${setSql} WHERE id = $1`, values);
      await audit({
        action: "workspace.retention_updated",
        targetType: "workspace",
        targetId: workspaceId,
        metadata: updates,
      });
    } catch {
      // The shared bounds above should make this unreachable, but a DB
      // CHECK violation (e.g. bounds drifted from the migration) would
      // otherwise surface as an unhandled 500 — return a friendly error.
      return { error: "Could not save retention. Please re-check the values and try again." };
    }
    return { notice: "Retention updated. Cleanup runs hourly; first purge will reflect new caps within ~60min." };
  });
}

/**
 * AXE-31 — global workspace search. Returns matching sources,
 * destinations, routes, and recent failed events for the active
 * workspace, scoped to LIMIT 5 per category so the palette stays
 * snappy under typing. ILIKE matches name + id; recent events
 * match by event_id prefix (UUID-y, exact paste-and-search is
 * the most useful operator workflow).
 */
export interface WorkspaceSearchHit {
  kind: "source" | "destination" | "route" | "dead_letter";
  id: string;
  label: string;
  hint: string;
  href: string;
}

export async function searchWorkspaceAction(query: string): Promise<WorkspaceSearchHit[]> {
  return withWorkspaceMutation({ role: "any", gateError: () => [] }, async ({ workspaceId }) => {
    const q = query.trim();
    if (q.length < 2) return [];
    const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`;
    const pool = db();
    // Five small queries in parallel is faster than one giant UNION
    // and lets us LIMIT each category independently.
    const [sources, destinations, routes, deadLetters] = await Promise.all([
      pool.query<{ id: string; name: string | null }>(
        `SELECT id, name FROM sources
          WHERE workspace_id = $1 AND (name ILIKE $2 OR id ILIKE $2)
          ORDER BY updated_at DESC LIMIT 5`,
        [workspaceId, like],
      ),
      pool.query<{ id: string; name: string | null; type: string }>(
        `SELECT id, name, type FROM destinations
          WHERE workspace_id = $1 AND (name ILIKE $2 OR id ILIKE $2)
          ORDER BY updated_at DESC LIMIT 5`,
        [workspaceId, like],
      ),
      pool.query<{ id: string; source_id: string }>(
        `SELECT id, source_id FROM routes
          WHERE workspace_id = $1 AND id ILIKE $2
          ORDER BY created_at DESC LIMIT 5`,
        [workspaceId, like],
      ),
      pool.query<{ event_id: string; reason: string }>(
        `SELECT event_id, reason FROM dead_letters
          WHERE workspace_id = $1 AND event_id ILIKE $2
          ORDER BY errored_at DESC LIMIT 5`,
        [workspaceId, like],
      ),
    ]);
    const hits: WorkspaceSearchHit[] = [];
    for (const r of sources.rows) {
      hits.push({
        kind: "source",
        id: r.id,
        label: r.name ?? r.id,
        hint: r.id,
        href: `/sources/${r.id}`,
      });
    }
    for (const r of destinations.rows) {
      hits.push({
        kind: "destination",
        id: r.id,
        label: r.name ?? r.id,
        hint: `${r.type} · ${r.id}`,
        href: `/destinations/${r.id}`,
      });
    }
    for (const r of routes.rows) {
      hits.push({
        kind: "route",
        id: r.id,
        label: r.id,
        hint: `route on ${r.source_id}`,
        href: `/routes/${r.id}`,
      });
    }
    for (const r of deadLetters.rows) {
      hits.push({
        kind: "dead_letter",
        id: r.event_id,
        label: r.event_id,
        hint: `dead letter · ${r.reason}`,
        href: `/inbox?event_id=${encodeURIComponent(r.event_id)}`,
      });
    }
    return hits;
  });
}

/**
 * AXE-29 — workspace API key management actions. Same one-time-
 * reveal pattern as webhook signing secrets: the plaintext is
 * returned only in the response to the create call; subsequent
 * fetches show only the key prefix.
 */
export async function createWorkspaceApiKeyAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, actorUserId, audit }) => {
    const name = formValue(formData, "name");
    if (!name || name.length < 2 || name.length > 64) {
      return { error: "Name must be 2–64 characters." };
    }
    const scopes = formData
      .getAll("scopes")
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (scopes.length === 0) {
      return { error: "Pick at least one scope." };
    }
    const valid = ["read", "write", "replay", "admin"] as const;
    const invalid = scopes.filter((s) => !valid.includes(s as (typeof valid)[number]));
    if (invalid.length > 0) {
      return { error: `Unknown scopes: ${invalid.join(", ")}.` };
    }
    const { createApiKey } = await import("./api-keys");
    const { plaintext, row } = await createApiKey({
      workspaceId,
      createdByUserId: actorUserId,
      name,
      scopes: scopes as Array<"read" | "write" | "replay" | "admin">,
    });
    await audit({
      action: "api_key.created",
      targetType: "api_key",
      targetId: row.id,
      metadata: { name, scopes },
    });
    revalidatePath("/settings");
    return {
      notice: `API key created. The plaintext below is shown ONCE — copy it now.`,
      data: { plaintextToken: plaintext, sourceId: row.id } as ActionState["data"],
    };
  });
}

export async function revokeWorkspaceApiKeyAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  return withWorkspaceMutation({}, async ({ workspaceId, audit }) => {
    const keyId = formValue(formData, "key_id");
    if (!keyId) return { error: "Missing key_id." };
    const { revokeApiKey } = await import("./api-keys");
    const revoked = await revokeApiKey(workspaceId, keyId);
    if (!revoked) return { error: "Key not found or already revoked." };
    await audit({
      action: "api_key.revoked",
      targetType: "api_key",
      targetId: keyId,
      metadata: {},
    });
    revalidatePath("/settings");
    return { notice: "API key revoked. Subsequent requests will be rejected with 401." };
  });
}
