"use server";

import { requireSuperAdmin } from "./admin-auth";
import { requireSession } from "./session";
import { processErasureRequest, type ProcessErasureResult } from "./erasure-lifecycle";
import type { SubjectIdentifier } from "./erasure-subject-id";
import type { ActionState } from "./action-data";
import { deploymentCapabilities } from "./deployment-capabilities";

/** Parse repeated (kind,value) form pairs into subject identifiers. */
function readIdentifiers(formData: FormData): SubjectIdentifier[] {
  const kinds = formData.getAll("kind").map((v) => String(v).trim());
  const values = formData.getAll("value").map((v) => String(v).trim());
  const identifiers: SubjectIdentifier[] = [];
  for (let i = 0; i < Math.max(kinds.length, values.length); i++) {
    const kind = kinds[i];
    const value = values[i];
    if (kind && value) identifiers.push({ kind, value });
  }
  return identifiers;
}

/** Turn a lifecycle result into a human-readable ActionState. */
function summarize(res: ProcessErasureResult): ActionState {
  if (res.state === "blocked_large_set") return { error: res.error };
  const erasedCount = () => res.storeResults.filter((s) => s.status === "deleted").reduce((n, s) => n + s.count, 0);
  if (res.state === "failed") {
    return { error: "The erasure request did not complete. Review the erasure audit record." };
  }
  const located = `Located ${res.matchedEventCount} event${res.matchedEventCount === 1 ? "" : "s"} (coverage: ${res.coverage})`;
  if (!res.executed) {
    return { notice: `${located}. This deployment is in erasure dry-run mode, so nothing was deleted.` };
  }
  const erased = erasedCount();
  return { notice: `${located}. Erased ${erased} record${erased === 1 ? "" : "s"} across stores.` };
}

/**
 * Super-admin server action wrapping the erasure lifecycle. Takes an arbitrary
 * `workspace_id` from the form (super-admin operates across workspaces). Erasure
 * only DELETES when ERASURE_EXECUTE_ENABLED=true; otherwise it dry-runs.
 */
export async function runErasureAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await requireSuperAdmin();
  if (!deploymentCapabilities().indexedSubjectErasure) {
    return { error: "Indexed subject erasure is unavailable in the small self-host profile." };
  }
  const workspaceId = String(formData.get("workspace_id") ?? "").trim();
  if (!workspaceId) return { error: "Missing workspace id." };
  const identifiers = readIdentifiers(formData);
  if (identifiers.length === 0) return { error: "Provide at least one subject identifier (kind + value)." };
  const confirmLargeSet = String(formData.get("confirm_large_set") ?? "") === "yes";
  try {
    return summarize(await processErasureRequest(workspaceId, identifiers, auth.user.id, { confirmLargeSet }));
  } catch {
    return { error: "The erasure request failed. Review the operator logs and try again." };
  }
}

/**
 * Customer-facing (workspace owner) erasure. The workspace is ALWAYS taken from
 * the authenticated session — never a form field — so a customer can only erase
 * within their own workspace. Owner-only, since erasure is irreversible.
 */
export async function runWorkspaceErasureAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  const session = await requireSession();
  if (!session.activeWorkspace?.workspace_id) return { error: "No active workspace." };
  if (session.activeWorkspace.role !== "owner") {
    return { error: "Only the workspace owner can run an erasure request." };
  }
  if (!deploymentCapabilities().indexedSubjectErasure) {
    return { error: "Indexed subject erasure is unavailable in the small self-host profile." };
  }
  const workspaceId = session.activeWorkspace.workspace_id;
  const identifiers = readIdentifiers(formData);
  if (identifiers.length === 0) return { error: "Provide at least one subject identifier (kind + value)." };
  const confirmLargeSet = String(formData.get("confirm_large_set") ?? "") === "yes";
  try {
    return summarize(await processErasureRequest(workspaceId, identifiers, session.user.id, { confirmLargeSet }));
  } catch {
    return { error: "The erasure request failed. Review the operator logs and try again." };
  }
}
