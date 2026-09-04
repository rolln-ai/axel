import "server-only";
import { sanitizeConnectorDiagnosticForStorage } from "@axel/shared";
import { db, type Queryable } from "./db";
import { sendEmail, type SendArgs, type SendResult } from "./email";
import {
  appUrl,
  emailButton,
  emailHeading,
  emailLink,
  emailNote,
  emailParagraph,
  emailTextSignature,
  escapeHtml,
  renderBrandedEmail,
} from "./email-layout";
import type { NotificationSeverity } from "./notifications";

/**
 * Immediate alert lane.
 *
 * Most notifications wait for the daily digest (lib/data-contracts/
 * email-digest.ts). A small, high-severity set — a *new* error type started
 * failing deliveries — instead emails right away so users are actually
 * "alerted" rather than finding out a day later. The notification-scan cron
 * (lib/notification-scan.ts) calls this once, the first time it sees a new
 * dead-letter fingerprint, then stamps `notifications.alerted_at` so the row
 * is excluded from the next digest (no double-send).
 *
 * "Help, don't exploit" guardrails live in the caller (dedup ledger + per-scan
 * and per-day caps); this module's only restraint is the per-user opt-out:
 * `prefs.email_immediate === false` suppresses the email for that member. In-app
 * notifications are never suppressed — only this email lane is.
 */

export interface ImmediateAlertNotification {
  kind: string;
  severity: NotificationSeverity;
  title: string;
  body_md: string | null;
  link_path: string | null;
}

export interface ImmediateAlertRecipientRow {
  workspace_name: string;
  user_id: string;
  email: string;
  prefs: Record<string, unknown> | null;
}

export interface ImmediateAlertSummary {
  recipients_scanned: number;
  recipients_opted_out: number;
  emails_sent: number;
  errors: Array<{ code: ImmediateAlertErrorCode }>;
}

export type ImmediateAlertErrorCode = "email_send_rejected" | "email_send_failed";

export interface ImmediateAlertDeps {
  listRecipients?: (
    workspaceId: string,
    client?: Queryable,
  ) => Promise<ImmediateAlertRecipientRow[]>;
  send?: (args: SendArgs) => Promise<SendResult>;
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

/**
 * Email an immediate alert to every member of `workspaceId` who hasn't opted
 * out. Returns a per-recipient summary; never throws (a single send failure is
 * recorded, not propagated, so one bad address can't abort the scan).
 */
export async function sendImmediateErrorAlert(
  workspaceId: string,
  notification: ImmediateAlertNotification,
  deps: ImmediateAlertDeps = {},
): Promise<ImmediateAlertSummary> {
  const listRecipients = deps.listRecipients ?? listImmediateAlertRecipients;
  const send = deps.send ?? sendEmail;

  const recipients = await listRecipients(workspaceId);
  const summary: ImmediateAlertSummary = {
    recipients_scanned: 0,
    recipients_opted_out: 0,
    emails_sent: 0,
    errors: [],
  };

  for (const r of recipients) {
    summary.recipients_scanned += 1;
    if (!optedInToImmediate(r.prefs)) {
      summary.recipients_opted_out += 1;
      continue;
    }
    const { subject, html, text } = renderImmediateAlert(r.workspace_name, notification);
    try {
      const result = await send({ to: r.email, subject, html, text });
      if (result.ok) summary.emails_sent += 1;
      else summary.errors.push({ code: "email_send_rejected" });
    } catch {
      summary.errors.push({ code: "email_send_failed" });
    }
  }
  return summary;
}

export function renderImmediateAlert(
  workspaceName: string,
  n: ImmediateAlertNotification,
): { subject: string; html: string; text: string } {
  const app = appUrl();
  const tag = n.severity === "high" ? "🔴" : n.severity === "warning" ? "🟠" : "ℹ️";
  const link = n.link_path ? `${app}${n.link_path}` : null;
  const unsubscribe = `${app}/settings?tab=notifications`;
  const title = sanitizeConnectorDiagnosticForStorage(n.title, 200);
  const bodyText = n.body_md
    ? sanitizeConnectorDiagnosticForStorage(n.body_md.replace(/\s+/g, " ").trim(), 400)
    : null;

  const subject = `${tag} [${workspaceName}] ${title}`;
  const text = [
    `${workspaceName} — ${title}`,
    "",
    ...(bodyText ? [bodyText, ""] : []),
    ...(link ? [`Investigate: ${link}`, ""] : []),
    "You're getting this because immediate alerts are on for this workspace.",
    emailTextSignature(`Manage notification settings: ${unsubscribe}`),
  ].join("\n");

  const html = renderBrandedEmail({
    preheader: bodyText ? bodyText.slice(0, 140) : `${workspaceName} — ${title}`,
    contentHtml: [
      emailNote(`${tag} ${escapeHtml(workspaceName)}`),
      emailHeading(title),
      bodyText ? emailParagraph(escapeHtml(bodyText.slice(0, 400))) : "",
      link ? emailButton(link, "Investigate →") : "",
    ].join(""),
    footerNote: `You're getting this because immediate alerts are on for <strong>${escapeHtml(workspaceName)}</strong>. ${emailLink(unsubscribe, "Manage notification settings")}.`,
  });

  return { subject, html, text };
}
