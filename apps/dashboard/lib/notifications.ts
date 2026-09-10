import "server-only";
import { db, type Queryable } from "./db";
import { prefixedId } from "./ids";

export type NotificationSeverity = "info" | "warning" | "high";

export interface NotificationRow {
  id: string;
  workspace_id: string;
  user_id: string | null;
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body_md: string | null;
  link_path: string | null;
  dedup_key: string | null;
  metadata: unknown;
  created_at: string;
  read_at: string | null;
  alerted_at: string | null;
}

export interface CreateNotificationInput {
  workspaceId: string;
  userId?: string | null;
  kind: string;
  severity?: NotificationSeverity;
  title: string;
  bodyMd?: string | null;
  linkPath?: string | null;
  /** Set this to suppress duplicate unread notifications with the same key. */
  dedupKey?: string | null;
  metadata?: unknown;
  /**
   * When true, stamp `alerted_at = now()` on insert. The immediate alert lane
   * (lib/notification-alerts.ts) sets this so the daily digest excludes the row
   * — the user already got an email for it, so it must not also appear in the
   * next digest. Default false (digest-delivered).
   */
  alertedAt?: boolean;
}

const COLUMNS = `id, workspace_id, user_id, kind, severity, title, body_md, link_path,
  dedup_key, metadata, created_at::text, read_at::text, alerted_at::text`;

/**
 * Billing notifications describe live gates, not durable history. Reconcile
 * them against the workspace's current plan/status before rendering or
 * counting them so a quota alert disappears as soon as an upgrade lands (and
 * payment/suspension alerts disappear after recovery).
 *
 * This intentionally stamps the stale rows read instead of only filtering the
 * SELECT. Besides fixing the Inbox, it releases the active dedup key and keeps
 * every other notification consumer from resurfacing an alert that is no
 * longer true.
 */
export async function resolveInactiveBillingNotifications(
  workspaceId: string,
  client: Queryable = db(),
): Promise<number> {
  const result = await client.query(
    `UPDATE notifications n
        SET read_at = now()
       FROM workspaces w
       LEFT JOIN workspace_usage_period up
         ON up.workspace_id = w.id
        AND up.period_start = date_trunc('month', now() AT TIME ZONE 'UTC')::date
      WHERE n.workspace_id = $1
        AND w.id = n.workspace_id
        AND n.read_at IS NULL
        AND n.kind LIKE 'billing\\_%'
        AND (
          (n.kind = 'billing_quota_blocked' AND NOT (
            w.plan = 'free'
            AND NOT COALESCE(w.billing_exempt, false)
            AND COALESCE(up.total_tasks, 0) >= 10000
          ))
          OR (n.kind = 'billing_quota_warning' AND NOT (
            w.plan = 'free'
            AND NOT COALESCE(w.billing_exempt, false)
            AND COALESCE(up.total_tasks, 0) >= 8000
            AND COALESCE(up.total_tasks, 0) < 10000
          ))
          OR (n.kind = 'billing_payment_failed' AND w.billing_status <> 'past_due')
          OR (n.kind = 'billing_suspended' AND w.billing_status <> 'suspended')
        )`,
    [workspaceId],
  );
  return result.rowCount ?? 0;
}

/**
 * Insert a notification, with dedup against the unique partial index. If
 * an unread notification with the same `(workspace_id, user_id, kind,
 * dedup_key)` already exists, the insert raises a 23505 unique violation
 * and we return `null` rather than throwing — the caller treats that as
 * "already notified, no need to repeat".
 */
export async function emitNotification(
  input: CreateNotificationInput,
  client: Queryable = db(),
): Promise<NotificationRow | null> {
  const id = prefixedId("notif");
  try {
    const result = await client.query<NotificationRow>(
      `INSERT INTO notifications (
         id, workspace_id, user_id, kind, severity, title,
         body_md, link_path, dedup_key, metadata, alerted_at
       ) VALUES ($1, $2, $3, $4, COALESCE($5, 'info'), $6, $7, $8, $9,
                 COALESCE($10::jsonb, '{}'::jsonb),
                 CASE WHEN $11::boolean THEN now() ELSE NULL END)
       RETURNING ${COLUMNS}`,
      [
        id,
        input.workspaceId,
        input.userId ?? null,
        input.kind,
        input.severity ?? null,
        input.title,
        input.bodyMd ?? null,
        input.linkPath ?? null,
        input.dedupKey ?? null,
        input.metadata === undefined ? null : JSON.stringify(input.metadata),
        input.alertedAt ?? false,
      ],
    );
    return result.rows[0] ?? null;
  } catch (err) {
    if (err instanceof Error && /notifications_active_dedup_idx/.test(err.message)) {
      // An identical unread notification already exists — that's the whole
      // point of the dedup index. Quietly succeed without a new row.
      return null;
    }
    throw err;
  }
}

export async function listNotifications(
  workspaceId: string,
  userId: string,
  options: { onlyUnread?: boolean; limit?: number } = {},
  client: Queryable = db(),
): Promise<NotificationRow[]> {
  const limit = options.limit ?? 50;
  const where = options.onlyUnread
    ? "WHERE workspace_id = $1 AND (user_id = $2 OR user_id IS NULL) AND read_at IS NULL"
    : "WHERE workspace_id = $1 AND (user_id = $2 OR user_id IS NULL)";
  const result = await client.query<NotificationRow>(
    `SELECT ${COLUMNS}
       FROM notifications
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    [workspaceId, userId],
  );
  return result.rows;
}

export async function countUnreadNotifications(
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM notifications
      WHERE workspace_id = $1
        AND (user_id = $2 OR user_id IS NULL)
        AND read_at IS NULL`,
    [workspaceId, userId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

/**
 * Unread `billing_*` notifications (quota warnings, payment failures,
 * suspensions, usage spikes). Surfaced in the /inbox billing-alerts strip
 * now that the in-app bell is gone — billing must stay visible without
 * relying on email. `\_` escapes LIKE's single-char wildcard.
 */
export async function listUnreadBillingNotifications(
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<NotificationRow[]> {
  await resolveInactiveBillingNotifications(workspaceId, client);
  const result = await client.query<NotificationRow>(
    `SELECT ${COLUMNS}
       FROM notifications
      WHERE workspace_id = $1
        AND (user_id = $2 OR user_id IS NULL)
        AND read_at IS NULL
        AND kind LIKE 'billing\\_%'
      ORDER BY created_at DESC
      LIMIT 20`,
    [workspaceId, userId],
  );
  return result.rows;
}

export async function countUnreadBillingNotifications(
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<number> {
  await resolveInactiveBillingNotifications(workspaceId, client);
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM notifications
      WHERE workspace_id = $1
        AND (user_id = $2 OR user_id IS NULL)
        AND read_at IS NULL
        AND kind LIKE 'billing\\_%'`,
    [workspaceId, userId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

export async function markNotificationRead(
  id: string,
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<void> {
  await client.query(
    `UPDATE notifications
        SET read_at = now()
      WHERE id = $1
        AND workspace_id = $2
        AND (user_id = $3 OR user_id IS NULL)
        AND read_at IS NULL`,
    [id, workspaceId, userId],
  );
}

// ── Per-user notification preferences ───────────────────────────────────────

/**
 * The notification preferences we read today. Stored in the
 * `notification_preferences.prefs` JSONB; absent keys default to ON (subscribed)
 * so a brand-new user is opted into everything until they choose otherwise.
 * Each flag gates an EMAIL lane only — in-app notifications are never suppressed.
 */
export interface NotificationPreferences {
  /** Optional weekly schema digest email (lib/data-contracts/email-digest.ts). */
  email_schema_weekly: boolean;
  /** Immediate alert emails for serious events (lib/notification-alerts.ts). */
  email_immediate: boolean;
}

export async function getNotificationPreferences(
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<NotificationPreferences> {
  const result = await client.query<{ prefs: Record<string, unknown> | null }>(
    `SELECT prefs FROM notification_preferences
      WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  const prefs = result.rows[0]?.prefs ?? null;
  return {
    email_schema_weekly: prefs?.email_schema_weekly === true,
    email_immediate: prefs?.email_immediate !== false,
  };
}

export async function upsertNotificationPreferences(
  workspaceId: string,
  userId: string,
  update: Partial<NotificationPreferences>,
  client: Queryable = db(),
): Promise<void> {
  // Merge into the existing JSONB (`||`) so we only touch the keys we manage and
  // leave any future / unrelated prefs intact.
  await client.query(
    `INSERT INTO notification_preferences (workspace_id, user_id, prefs, updated_at)
     VALUES ($1, $2, $3::jsonb, now())
     ON CONFLICT (workspace_id, user_id)
     DO UPDATE SET prefs = notification_preferences.prefs || EXCLUDED.prefs,
                   updated_at = now()`,
    [workspaceId, userId, JSON.stringify(update)],
  );
}

export async function markAllNotificationsRead(
  workspaceId: string,
  userId: string,
  client: Queryable = db(),
): Promise<number> {
  const result = await client.query(
    `UPDATE notifications
        SET read_at = now()
      WHERE workspace_id = $1
        AND (user_id = $2 OR user_id IS NULL)
        AND read_at IS NULL`,
    [workspaceId, userId],
  );
  return result.rowCount ?? 0;
}

/**
 * Drift → notification fan-out. Emits one workspace-wide notification per
 * DetectedDrift, dedup-keyed by (map, category, field_path) so re-running
 * the detector doesn't fan out duplicate unread alerts.
 *
 * Severity escalates with the category:
 *   high    — new_sensitive_field (potential PII leak, immediate review)
 *   warning — missing_field, type_change, unknown_shape (likely breakage)
 *   info    — new_event_type (informational; user opts in to handle)
 */
export interface DriftNotificationInput {
  category:
    | "new_event_type"
    | "missing_field"
    | "type_change"
    | "new_sensitive_field"
    | "unknown_shape";
  field_path: string | null;
}

const DRIFT_SEVERITY: Record<DriftNotificationInput["category"], NotificationSeverity> = {
  new_sensitive_field: "high",
  missing_field: "warning",
  type_change: "warning",
  unknown_shape: "warning",
  new_event_type: "info",
};

const DRIFT_TITLE: Record<DriftNotificationInput["category"], string> = {
  new_sensitive_field: "New sensitive field detected",
  missing_field: "Required field missing",
  type_change: "Field type changed",
  unknown_shape: "Known event type with unknown shape",
  new_event_type: "New event type detected",
};

export async function notifyOnDrift(
  workspaceId: string,
  dataContractId: string,
  drifts: DriftNotificationInput[],
  client: Queryable = db(),
): Promise<number> {
  let emitted = 0;
  for (const drift of drifts) {
    const row = await emitNotification(
      {
        workspaceId,
        userId: null, // workspace-wide; every member sees it
        kind: "data_contract_drift",
        severity: DRIFT_SEVERITY[drift.category],
        title: DRIFT_TITLE[drift.category],
        bodyMd: drift.field_path
          ? `Path \`${drift.field_path}\` on Data Contract \`${dataContractId}\`.`
          : `Data Contract \`${dataContractId}\`.`,
        linkPath: `/data-contracts/${dataContractId}`,
        dedupKey: `${dataContractId}:${drift.category}:${drift.field_path ?? ""}`,
        metadata: { data_contract_id: dataContractId, drift_category: drift.category },
      },
      client,
    );
    if (row) emitted += 1;
  }
  return emitted;
}
