import "server-only";
import { isTransientPostgresError } from "@axel/observability";
import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";
import { db, type Queryable } from "./db";
import { loadInboxGroups, type InboxGroup } from "./inbox";
import {
  emitNotification,
  type CreateNotificationInput,
  type NotificationRow,
} from "./notifications";
import {
  sendImmediateErrorAlert,
  type ImmediateAlertNotification,
  type ImmediateAlertSummary,
} from "./notification-alerts";

/**
 * "A new error type started occurring" detector. Runs every ~15 minutes from
 * the notification-scan cron.
 *
 * The Inbox (lib/inbox.ts) already groups dead letters by an opaque
 * `fingerprint` — so a *new fingerprint* is precisely "a new error type", and
 * 100 identical failures already collapse to one fingerprint. This scan turns
 * that into a notification + (for the first occurrence) an immediate email,
 * while guaranteeing one alert per error, not one per occurrence.
 *
 * Dedup authority is the `notification_active_errors` ledger, NOT the
 * notification's read state:
 *   - reconcile: drop ledger rows whose fingerprint is no longer active
 *     (its dead letters were resolved), so a later recurrence re-alerts;
 *   - claim: INSERT ... ON CONFLICT DO NOTHING RETURNING — the row that
 *     RETURNs is the single "this is new" event and drives the one email,
 *     race-safe across overlapping scans.
 *
 * Rate limits (so a multi-fingerprint incident can't mailbomb): at most
 * PER_SCAN_EMAIL_CAP immediate emails per workspace per scan, and a rolling
 * DAILY_EMAIL_CAP per workspace per UTC day. Beyond the caps the in-app
 * notification is still created — it just rides the daily digest instead of
 * emailing immediately.
 */

const PER_SCAN_EMAIL_CAP = 5;
const DAILY_EMAIL_CAP = 20;
const NEW_ERROR_KIND = "new_error_type";

export interface NotificationScanSummary {
  workspaces_scanned: number;
  new_errors_detected: number;
  alerts_emailed: number;
  recipients_emailed: number;
  ledger_rows_reconciled: number;
  errors: Array<{ code: NotificationScanErrorCode }>;
  duration_ms: number;
}

export type NotificationScanErrorCode =
  | "alert_send_failed"
  | "workspace_scan_failed"
  | "transient_dependency";

export interface PublicNotificationScanSummary {
  workspaces_scanned: number;
  new_errors_detected: number;
  alerts_emailed: number;
  recipients_emailed: number;
  ledger_rows_reconciled: number;
  error_count: number;
  error_counts: Record<NotificationScanErrorCode, number>;
  duration_ms: number;
}

/** Project the cron result to aggregate, identifier-free response data. */
export function publicNotificationScanSummary(
  summary: NotificationScanSummary,
): PublicNotificationScanSummary {
  const errorCounts: Record<NotificationScanErrorCode, number> = {
    alert_send_failed: 0,
    workspace_scan_failed: 0,
    transient_dependency: 0,
  };
  for (const error of summary.errors) errorCounts[error.code] += 1;
  return {
    workspaces_scanned: summary.workspaces_scanned,
    new_errors_detected: summary.new_errors_detected,
    alerts_emailed: summary.alerts_emailed,
    recipients_emailed: summary.recipients_emailed,
    ledger_rows_reconciled: summary.ledger_rows_reconciled,
    error_count: summary.errors.length,
    error_counts: errorCounts,
    duration_ms: summary.duration_ms,
  };
}

export interface NotificationScanDeps {
  /** Workspaces with at least one unresolved dead letter. */
  listWorkspaceIds?: (client?: Queryable) => Promise<string[]>;
  /** Active + recently-resolved dead-letter groups for a workspace. */
  loadGroups?: (workspaceId: string) => Promise<InboxGroup[]>;
  /** Delete ledger rows whose fingerprint isn't in `activeFingerprints`. Returns rows removed. */
  reconcile?: (workspaceId: string, activeFingerprints: string[], client?: Queryable) => Promise<number>;
  /** Claim a fingerprint; true only the first time (drives the single alert). */
  claim?: (workspaceId: string, fingerprint: string, reason: string, client?: Queryable) => Promise<boolean>;
  /** Count of new_error_type rows already emailed this UTC day for the workspace. */
  countTodaysAlerts?: (workspaceId: string, client?: Queryable) => Promise<number>;
  emit?: (input: CreateNotificationInput, client?: Queryable) => Promise<NotificationRow | null>;
  sendAlert?: (workspaceId: string, n: ImmediateAlertNotification) => Promise<ImmediateAlertSummary>;
  client?: Queryable;
}

export function shouldReportNotificationScanError(error: unknown): boolean {
  return !isTransientPostgresError(error);
}

export async function runNotificationScan(
  deps: NotificationScanDeps = {},
): Promise<NotificationScanSummary> {
  const start = Date.now();
  // Left undefined unless explicitly injected: the default ledger/query helpers
  // each fall back to db() via their own default param, so db() is only touched
  // on the real path — fully-injected tests never connect.
  const client = deps.client;
  const listWorkspaceIds = deps.listWorkspaceIds ?? listWorkspacesWithUnresolvedDeadLetters;
  const loadGroups = deps.loadGroups ?? loadInboxGroups;
  const reconcile = deps.reconcile ?? reconcileActiveErrors;
  const claim = deps.claim ?? claimActiveError;
  const countTodaysAlerts = deps.countTodaysAlerts ?? countTodaysErrorAlerts;
  const emit = deps.emit ?? emitNotification;
  const sendAlert = deps.sendAlert ?? ((wsId, n) => sendImmediateErrorAlert(wsId, n));

  const summary: NotificationScanSummary = {
    workspaces_scanned: 0,
    new_errors_detected: 0,
    alerts_emailed: 0,
    recipients_emailed: 0,
    ledger_rows_reconciled: 0,
    errors: [],
    duration_ms: 0,
  };

  const workspaceIds = await listWorkspaceIds(client);
  for (const workspaceId of workspaceIds) {
    summary.workspaces_scanned += 1;
    try {
      const groups = await loadGroups(workspaceId);
      // Active = at least one unresolved dead letter. These define the ledger's
      // current truth; everything else gets reconciled away.
      const active = groups.filter((g) => g.count > 0);
      const activeFingerprints = active.map((g) => g.fingerprint);
      summary.ledger_rows_reconciled += await reconcile(workspaceId, activeFingerprints, client);

      const todaysAlerts = await countTodaysAlerts(workspaceId, client);
      let emailsThisScan = 0;

      for (const group of active) {
        // Claim every active fingerprint (muted included) so only NEW errors
        // alert.
        const isNew = await claim(workspaceId, group.fingerprint, group.reason, client);
        if (!isNew) continue;

        // A muted fingerprint silences the noisy EMAIL channel only — it still
        // surfaces in the in-app bell so operators aren't blind to an ongoing
        // incident they muted in the Inbox (audit: muting suppressed the in-app
        // notification entirely, and unmuting never restored visibility).
        const muted = group.muted_until !== null;
        const willEmail =
          !muted &&
          emailsThisScan < PER_SCAN_EMAIL_CAP &&
          todaysAlerts + emailsThisScan < DAILY_EMAIL_CAP;

        const notification = buildNewErrorNotification(group, workspaceId);

        // Send the immediate email FIRST, then record the in-app notification with
        // alerted_at reflecting whether the email ACTUALLY went out. Previously
        // emit() stamped alerted_at=willEmail before sendAlert, so a send failure
        // (e.g. a listRecipients DB error) left the row marked "alerted" — and the
        // digest lane (alerted_at IS NULL) then skipped it too, blackholing the
        // alert from BOTH lanes. Now a failed send leaves alerted_at NULL so the
        // digest lane still delivers it; the in-app bell shows either way. The
        // per-group try also stops one send failure from aborting the whole
        // workspace's remaining notifications. Email is gated on the ledger claim
        // above, not emit()'s return (see module header).
        let emailed = false;
        if (willEmail) {
          try {
            const result = await sendAlert(workspaceId, notification);
            emailsThisScan += 1;
            summary.alerts_emailed += 1;
            summary.recipients_emailed += result.emails_sent;
            emailed = true;
          } catch (err) {
            summary.errors.push({
              code: shouldReportNotificationScanError(err)
                ? "alert_send_failed"
                : "transient_dependency",
            });
          }
        }

        await emit(
          {
            workspaceId,
            userId: null, // workspace-wide: every member sees it in the bell
            kind: NEW_ERROR_KIND,
            severity: "high",
            title: notification.title,
            bodyMd: notification.body_md,
            linkPath: notification.link_path,
            dedupKey: `error:${group.fingerprint}`,
            metadata: {
              fingerprint: group.fingerprint,
              reason: group.reason,
              source_id: group.source_id,
              failing_count: group.count,
            },
            alertedAt: emailed,
          },
          client,
        );
        summary.new_errors_detected += 1;
      }
    } catch (err) {
      summary.errors.push({
        code: shouldReportNotificationScanError(err)
          ? "workspace_scan_failed"
          : "transient_dependency",
      });
    }
  }

  summary.duration_ms = Date.now() - start;
  return summary;
}

export function buildNewErrorNotification(
  group: InboxGroup,
  workspaceId: string,
): ImmediateAlertNotification {
  const noun = group.count === 1 ? "delivery is" : "deliveries are";
  const excerpt = sanitizeConnectorDiagnosticForStorage(
    group.message_excerpt.replace(/\s+/g, " ").trim(),
    240,
  );
  return {
    kind: NEW_ERROR_KIND,
    severity: "high",
    title: sanitizeConnectorDiagnosticForStorage(
      `New delivery error: ${group.reason}`,
      200,
    ),
    body_md: `${group.count} ${noun} failing — ${excerpt}`,
    // This route verifies membership, activates the workspace in the session,
    // then redirects to /inbox. A plain /inbox link opens whichever workspace
    // the recipient happened to use last, which is wrong for multi-workspace
    // users receiving an alert about another workspace.
    link_path: `/workspaces/${encodeURIComponent(workspaceId)}/inbox`,
  };
}

// ── Ledger helpers (the email-dedup authority) ──────────────────────────────

export async function listWorkspacesWithUnresolvedDeadLetters(
  client: Queryable = db(),
): Promise<string[]> {
  // INNER JOIN workspaces so we never hand the ledger a workspace_id that no
  // longer exists. dead_letters has no FK to workspaces (it's a high-volume
  // hot-path table), so a hard-deleted workspace leaves its dead_letters rows
  // orphaned. Without this join those orphans flow into claimActiveError and
  // trip notification_active_errors_workspace_id_fkey on every scan. (JAVASCRIPT-2F)
  // Also include workspaces that have notification_active_errors ledger rows but
  // NO unresolved dead letters: once every dead letter is resolved a workspace
  // dropped out of this list entirely, so its ledger was never pruned — and a
  // later recurrence of the same fingerprint was deduped as "already alerted"
  // and never re-alerted (audit: stale ledger blocks re-alerts). Scanning it now
  // lets the reconcile clear the stale rows so a recurrence alerts again.
  const result = await client.query<{ workspace_id: string }>(
    `SELECT DISTINCT dl.workspace_id
       FROM dead_letters dl
       JOIN workspaces w ON w.id = dl.workspace_id
      WHERE dl.resolved_at IS NULL
     UNION
     SELECT DISTINCT nae.workspace_id
       FROM notification_active_errors nae
       JOIN workspaces w ON w.id = nae.workspace_id`,
  );
  return result.rows.map((r) => r.workspace_id);
}

/**
 * Delete ledger rows for fingerprints that are no longer active. An empty
 * `activeFingerprints` clears every row for the workspace (all errors resolved).
 */
async function reconcileActiveErrors(
  workspaceId: string,
  activeFingerprints: string[],
  client: Queryable = db(),
): Promise<number> {
  const result = await client.query(
    `DELETE FROM notification_active_errors
      WHERE workspace_id = $1
        AND fingerprint <> ALL($2::text[])`,
    [workspaceId, activeFingerprints],
  );
  return result.rowCount ?? 0;
}

/**
 * Insert a ledger row, returning true only on the first claim. Concurrent scans
 * race here; exactly one wins (ON CONFLICT DO NOTHING), so exactly one emails.
 */
export async function claimActiveError(
  workspaceId: string,
  fingerprint: string,
  reason: string,
  client: Queryable = db(),
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO notification_active_errors (workspace_id, fingerprint, reason)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, fingerprint) DO NOTHING
     RETURNING workspace_id`,
    [workspaceId, fingerprint, reason],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function countTodaysErrorAlerts(
  workspaceId: string,
  client: Queryable = db(),
): Promise<number> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM notifications
      WHERE workspace_id = $1
        AND kind = $2
        AND alerted_at >= date_trunc('day', now())`,
    [workspaceId, NEW_ERROR_KIND],
  );
  return Number(result.rows[0]?.count ?? "0");
}
