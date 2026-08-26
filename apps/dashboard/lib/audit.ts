import "server-only";
import type { Queryable } from "./db";

/**
 * Canonical `audit_log` writer. Every audit insert in the dashboard goes
 * through here so the column list, JSON encoding of `metadata`, and NULL
 * conventions can't drift between call sites.
 *
 * Deliberately NO try/catch: callers keep their existing failure semantics
 * (an audit write inside a transaction still aborts the transaction; a
 * standalone write still surfaces to the action's own error handling).
 */
export interface AuditEntry {
  /** Null for platform-level events with no workspace (password reset, impersonation). */
  workspaceId: string | null;
  /** Null for non-user actors (API keys, system jobs). */
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string;
  /** JSON-encoded centrally. Omit to store an empty object. */
  metadata?: unknown;
}

/**
 * Insert one audit row. Pass the transaction client for in-transaction
 * callers (atomic with the mutation), or `db()` for standalone writes.
 */
export async function writeAudit(client: Queryable, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, action, target_type, target_id, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.workspaceId,
      entry.actorUserId,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.metadata === undefined ? "{}" : JSON.stringify(entry.metadata),
    ],
  );
}
