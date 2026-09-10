import "server-only";
import { db, type Queryable } from "./db";

export interface ImmediateAlertRecipientRow {
  workspace_name: string;
  user_id: string;
  email: string;
  prefs: Record<string, unknown> | null;
}

/** Default: every active-workspace member with an email, plus their prefs. */
export async function listImmediateAlertRecipients(
  workspaceId: string,
  client: Queryable = db(),
): Promise<ImmediateAlertRecipientRow[]> {
  const result = await client.query<ImmediateAlertRecipientRow>(
    `SELECT w.name      AS workspace_name,
            u.id::text   AS user_id,
            u.email,
            np.prefs
       FROM workspace_members wm
       JOIN users u      ON u.id = wm.user_id
       JOIN workspaces w ON w.id = wm.workspace_id
       LEFT JOIN notification_preferences np
         ON np.workspace_id = wm.workspace_id
        AND np.user_id      = wm.user_id
      WHERE wm.workspace_id = $1
        AND w.status = 'active'
        AND u.email IS NOT NULL`,
    [workspaceId],
  );
  return result.rows;
}

/** Absence of a row, or any value other than an explicit `false`, = opted in. */
export function optedInToImmediate(prefs: Record<string, unknown> | null): boolean {
  if (!prefs) return true;
  return prefs.email_immediate !== false;
}
