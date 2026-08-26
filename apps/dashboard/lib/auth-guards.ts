import "server-only";
import { computePlanState } from "./billing/plan-state";

/**
 * Shared mutation guards. Extracted from actions.ts so EVERY server-action
 * file applies the identical role / workspace-status / billing gates — the
 * v1.0.0 audit found inbox-actions.ts and the data-contracts refresh action
 * skipping these, letting viewers in suspended/over-quota workspaces mutate.
 *
 * Plain server-only module (NOT "use server") so the sync helpers can be
 * exported — a "use server" file may only export async server actions.
 */

export function requireWritableRole(role: "owner" | "admin" | "member"): string | null {
  // Deliberately action-neutral copy: this guard fronts sources, destinations,
  // deliveries, and workspace settings alike — naming one surface ("change
  // sources") made every other surface's rejection read like a non sequitur.
  if (role !== "owner" && role !== "admin") {
    return "Only owners and admins can make changes in this workspace.";
  }
  return null;
}

/**
 * Returns an `ActionState`-shaped error when the active workspace is not in
 * an `active` status — i.e. when a super-admin has suspended (or soft-deleted)
 * the workspace. Use this in every mutating action; read paths are intentionally
 * unaffected so users can still browse their data.
 */
export function requireActiveWorkspace(workspace: {
  workspace_status: "active" | "suspended" | "deleted";
}): string | null {
  if (workspace.workspace_status === "active") return null;
  if (workspace.workspace_status === "suspended") {
    return "This workspace is suspended. Contact support to restore it.";
  }
  return "This workspace is no longer available.";
}

/**
 * Billing gate shared by every replay entry point so the thresholds stay
 * byte-identical (reuses computePlanState).
 */
export async function replayBillingGateError(workspaceId: string): Promise<string | null> {
  const state = await computePlanState(workspaceId);
  // Unknown workspace (no row) — let the downstream INSERT's workspace-scoped
  // predicates reject it rather than masking that with a billing message.
  if (!state) return null;
  if (state.gate === "reject_suspended") {
    return "Billing is suspended for this workspace. Resolve the outstanding balance before replaying events.";
  }
  if (state.gate === "reject_quota") {
    return "This workspace has hit its monthly free-tier limit. Replays are paused until usage resets or you upgrade.";
  }
  return null;
}
