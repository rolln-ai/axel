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
    // Distinguish a pre-execute throw (res.error set, nothing erased) from a
    // partial store failure (some stores erased; details in the audit row).
    const failed = res.storeResults.filter((s) => s.status === "failed").map((s) => s.store);
    const detail = res.error ?? `${failed.join(", ")} failed — ${erasedCount()} record(s) erased before the failure`;
    return { error: `Erasure incomplete (request ${res.requestId}): ${detail}. See the erasure_requests audit row.` };
  }
  const located = `Located ${res.matchedEventCount} event${res.matchedEventCount === 1 ? "" : "s"} (coverage: ${res.coverage})`;
  if (!res.executed) {
    return { notice: `${located}. Execution is disabled (ERASURE_EXECUTE_ENABLED off) — nothing erased. Request ${res.requestId}.` };
  }
  const erased = erasedCount();
  return { notice: `${located}. Erased ${erased} record${erased === 1 ? "" : "s"} across stores. Request ${res.requestId}.` };
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
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Erasure request failed." };
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
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Erasure request failed." };
  }
}
