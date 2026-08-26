import "server-only";
import { updateTag } from "next/cache";
import { replayBillingGateError, requireActiveWorkspace, requireWritableRole } from "./auth-guards";
import { writeAudit, type AuditEntry } from "./audit";
import { db, type Queryable } from "./db";
import { cacheTags } from "./repositories";
import { requireSession, type CurrentSession } from "./session";

/**
 * The guard → mutate → audit → invalidate spine shared by every
 * workspace-scoped server action.
 *
 * The leaf predicates (`requireWritableRole`, `requireActiveWorkspace`,
 * `replayBillingGateError`) were extracted long ago, but the SEQUENCE that
 * calls them was hand-rolled ~50 times across actions.ts / inbox-actions.ts /
 * test-destination.ts — and copies drifted (the v1.0.0 audit found replay
 * paths shipping without the billing gate, and whole modules skipping
 * `requireActiveWorkspace`). This wrapper makes the gate ORDER fixed and
 * untestable-by-omission:
 *
 *   1. role gate       (owner/admin, unless `role: "any"`)
 *   2. workspace-status gate (always — suspended/deleted workspaces cannot mutate)
 *   3. billing gate    (opt-in via `billing: "replay"`, replay entry points only)
 *
 * The callback receives the resolved workspace/actor identity plus `audit()`
 * and `tags()` helpers pre-bound to the workspace, so bodies can't write an
 * audit row or bust a cache tag for the wrong tenant.
 */
export interface MutationContext {
  session: CurrentSession;
  workspaceId: string;
  actorUserId: string;
  /**
   * Insert one canonical audit row with workspaceId/actorUserId pre-filled.
   * Pass the transaction client for in-transaction callers so the audit row
   * commits (or rolls back) atomically with the mutation.
   */
  audit(entry: Omit<AuditEntry, "workspaceId" | "actorUserId">, client?: Queryable): Promise<void>;
  /** Bust one or more per-workspace cache-tag families (see `cacheTags`). */
  tags(...scopes: Array<keyof typeof cacheTags>): void;
}

export interface WorkspaceMutationOptions<TResult> {
  /**
   * "writable" (default): owner/admin only, via the shared guard copy.
   * "any": skip the shared role gate — for member-allowed mutations or
   * actions that carry their own stricter check (e.g. owner-only deletes).
   */
  role?: "writable" | "any";
  /**
   * Opt-in billing gate. "replay" applies the shared replay billing gate
   * (suspended billing / over-quota workspaces cannot enqueue billable
   * deliveries). Always runs AFTER the role + workspace-status gates.
   */
  billing?: "replay";
  /**
   * Map a gate rejection message into the action's result shape.
   * Defaults to the `ActionState`-style `{ error }`. Actions returning a
   * different envelope (e.g. `{ ok: false, message }`) must provide this.
   */
  gateError?: (error: string) => TResult;
}

export async function withWorkspaceMutation<TResult>(
  opts: WorkspaceMutationOptions<TResult>,
  fn: (ctx: MutationContext) => Promise<TResult>,
): Promise<TResult> {
  const session = await requireSession();
  const fail = opts.gateError ?? ((error: string) => ({ error }) as TResult);

  // 1. Role gate.
  if ((opts.role ?? "writable") === "writable") {
    const roleError = requireWritableRole(session.activeWorkspace.role);
    if (roleError) return fail(roleError);
  }

  // 2. Workspace-status gate — NOT optional. Suspended/deleted workspaces
  //    can browse but never mutate, on every surface.
  const wsError = requireActiveWorkspace(session.activeWorkspace);
  if (wsError) return fail(wsError);

  const workspaceId = session.activeWorkspace.workspace_id;
  const actorUserId = session.user.id;

  // 3. Billing gate (opt-in).
  if (opts.billing === "replay") {
    const billingError = await replayBillingGateError(workspaceId);
    if (billingError) return fail(billingError);
  }

  return fn({
    session,
    workspaceId,
    actorUserId,
    audit: (entry, client) =>
      writeAudit(client ?? db(), { workspaceId, actorUserId, ...entry }),
    tags: (...scopes) => {
      for (const scope of scopes) updateTag(cacheTags[scope](workspaceId));
    },
  });
}
