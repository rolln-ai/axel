import "server-only";
import { db, type Queryable } from "./db";
import { sendEmail, type SendResult } from "./email";
import {
  appUrl,
  emailButton,
  emailHeading,
  emailNote,
  emailParagraph,
  emailTextSignature,
  escapeHtml,
  renderBrandedEmail,
} from "./email-layout";

export interface AdminSignupAlertInput {
  userId: string;
  userName: string;
  userEmail: string;
  workspaceId: string;
  workspaceName: string;
  viaInvite: boolean;
}

export interface SuperAdminRecipient {
  user_id: string;
  email: string;
}

export interface AdminSignupAlertSummary {
  recipients_scanned: number;
  emails_sent: number;
  errors: Array<{ code: AdminSignupAlertErrorCode }>;
}

export type AdminSignupAlertErrorCode =
  | "recipient_lookup_failed"
  | "email_send_rejected"
  | "email_send_failed";

export async function listSuperAdminRecipients(
  client: Queryable = db(),
): Promise<SuperAdminRecipient[]> {
  const result = await client.query<SuperAdminRecipient>(
    `SELECT id::text AS user_id, email
       FROM users
      WHERE is_super_admin = true
        AND email IS NOT NULL
      ORDER BY id`,
  );
  return result.rows;
}

export function renderAdminSignupAlert(
  input: AdminSignupAlertInput,
): { subject: string; html: string; text: string } {
  const userUrl = `${appUrl()}/admin/users/${encodeURIComponent(input.userId)}`;
  const action = input.viaInvite
    ? `accepted an invitation to ${input.workspaceName}`
    : `created the workspace ${input.workspaceName}`;
  const subject = `New Axel signup — ${input.userEmail}`;
  const text = [
    "A new user signed up for Axel.",
    "",
    `${input.userName} (${input.userEmail}) ${action}.`,
    `Signup type: ${input.viaInvite ? "Invited member" : "New workspace owner"}`,
    "",
    `View user: ${userUrl}`,
    emailTextSignature("You receive this because your Axel account has super-admin access."),
  ].join("\n");

  const html = renderBrandedEmail({
    preheader: `${input.userName} ${action}.`,
    contentHtml: [
      emailNote("Admin notification"),
      emailHeading("A new user signed up"),
      emailParagraph(
        `<strong>${escapeHtml(input.userName)}</strong> (${escapeHtml(input.userEmail)}) ${escapeHtml(action)}.`,
      ),
      emailParagraph(
        `Signup type: <strong>${input.viaInvite ? "Invited member" : "New workspace owner"}</strong>`,
      ),
      emailButton(userUrl, "View user →"),
    ].join(""),
    footerNote: "You receive this because your Axel account has super-admin access.",
  });

  return { subject, html, text };
}

export interface AdminSignupAlertDeps {
  listRecipients?: () => Promise<SuperAdminRecipient[]>;
  send?: (args: {
    to: string;
    subject: string;
    html: string;
    text: string;
  }) => Promise<SendResult>;
}

/**
 * Best-effort operational alert. A recipient lookup or individual send failure
 * is recorded and returned, never thrown, so signup cannot depend on email.
 */
export async function sendAdminSignupAlert(
  input: AdminSignupAlertInput,
  deps: AdminSignupAlertDeps = {},
): Promise<AdminSignupAlertSummary> {
  const listRecipients = deps.listRecipients ?? listSuperAdminRecipients;
  const send = deps.send ?? sendEmail;
  const summary: AdminSignupAlertSummary = {
    recipients_scanned: 0,
    emails_sent: 0,
    errors: [],
  };

  let recipients: SuperAdminRecipient[];
  try {
    recipients = await listRecipients();
  } catch {
    summary.errors.push({ code: "recipient_lookup_failed" });
    return summary;
  }

  const message = renderAdminSignupAlert(input);
  for (const recipient of recipients) {
    summary.recipients_scanned += 1;
    try {
      const result = await send({ to: recipient.email, ...message });
      if (result.ok) summary.emails_sent += 1;
      else {
        summary.errors.push({ code: "email_send_rejected" });
      }
    } catch {
      summary.errors.push({ code: "email_send_failed" });
    }
  }

  return summary;
}
