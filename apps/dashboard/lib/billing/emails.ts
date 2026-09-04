import "server-only";
import { appBaseUrl } from "../app-url";
import type { Queryable } from "../db";
import { db } from "../db";
import { sendEmail } from "../email";
import {
  emailButton,
  emailCode,
  emailHeading,
  emailLink,
  emailParagraph,
  emailTextSignature,
  escapeHtml,
  renderBrandedEmail,
} from "../email-layout";

/**
 * Transactional billing emails.
 *
 * Triggered from the hourly rollup (PR-2) — when a workspace crosses
 * one of the notice thresholds we send a single email per
 * (workspace, threshold) using `billing_emails_sent` as the
 * idempotency journal. The journal is just `billing_events` repurposed
 * via the `type` discriminator below — keeps schema footprint small
 * and gives /admin/billing/webhooks visibility for free.
 *
 * Thresholds (free plan):
 *   tasks >= 8_000  → quota_warning   email
 *   tasks >= 10_000 → quota_blocked   email
 *
 * Per-billing-status (Stripe webhook side, see PR-3):
 *   billing_status='past_due'  → payment_failed   email
 *   billing_status='suspended' → billing_suspended email
 *
 * Per-period dedup: identifier embeds the period_start so a workspace
 * receives each notice at most once per calendar month. Crossing the
 * threshold again in a new month sends a fresh email.
 */

export type BillingEmailKind =
  | "quota_warning"
  | "quota_blocked"
  | "payment_failed"
  | "billing_suspended"
  | "upcoming_invoice"
  | "usage_spike";

export interface SendBillingEmailArgs {
  workspaceId: string;
  workspaceName: string;
  kind: BillingEmailKind;
  tasksThisPeriod: number;
  /** Estimated current-period invoice in cents (Pro). Drives upcoming_invoice / usage_spike copy. */
  estimatedCents?: number;
  /** Human label for the period end, e.g. "Jun 30". Used by upcoming_invoice. */
  periodEndLabel?: string;
}

export interface SendBillingEmailDeps {
  pg?: Queryable;
}

const SUBJECTS: Record<BillingEmailKind, (ws: string) => string> = {
  quota_warning: (ws) => `[${ws}] You're approaching your monthly task cap`,
  quota_blocked: (ws) => `[${ws}] Free-tier cap reached — ingest paused`,
  payment_failed: (ws) => `[${ws}] Payment failed`,
  billing_suspended: (ws) => `[${ws}] Billing suspended — ingest paused`,
  upcoming_invoice: (ws) => `[${ws}] Your upcoming invoice`,
  usage_spike: (ws) => `[${ws}] Usage is running higher than last month`,
};

const BODIES: Record<BillingEmailKind, (args: SendBillingEmailArgs) => { html: string; text: string }> = {
  quota_warning: ({ workspaceName: ws, tasksThisPeriod: tasks }) => ({
    text: [
      `${ws} has ingested ${tasks.toLocaleString()} tasks this month.`,
      ``,
      `The free tier allows 10,000 tasks per calendar month. Once you cross that, the ingest endpoint will return 429 until next month — or until you upgrade to Pro.`,
      ``,
      `Upgrade: ${billingUrl()}`,
      emailTextSignature(`Manage notification settings: ${notificationsUrl()}`),
    ].join("\n"),
    html: billingHtml(
      ws,
      `${tasks.toLocaleString()} tasks used this month — the free tier allows 10,000.`,
      [
        emailHeading("You're approaching your task cap"),
        emailParagraph(
          `<strong>${escapeHtml(ws)}</strong> has ingested <strong>${tasks.toLocaleString()}</strong> tasks this month.`,
        ),
        emailParagraph(
          `The free tier allows 10,000 tasks per calendar month. Once you cross that, ingest returns ${emailCode("429")} until next month — or until you upgrade to Pro.`,
        ),
        emailButton(billingUrl(), "Upgrade to Pro"),
      ].join(""),
    ),
  }),
  quota_blocked: ({ workspaceName: ws, tasksThisPeriod: tasks }) => ({
    text: [
      `${ws} has reached the free-tier cap of 10,000 tasks. The ingest endpoint is now returning 429 to new webhooks.`,
      ``,
      `You've ingested ${tasks.toLocaleString()} inbound events this month. Upgrade to Pro to resume immediately at $20/month applied as usage credit (covering about 1.33M events; further usage at $0.015 per 1,000).`,
      ``,
      `Upgrade: ${billingUrl()}`,
      emailTextSignature(`Manage notification settings: ${notificationsUrl()}`),
    ].join("\n"),
    html: billingHtml(
      ws,
      `Ingest paused at the 10,000-task free-tier cap — upgrade to resume.`,
      [
        emailHeading("Free-tier cap reached — ingest paused"),
        emailParagraph(
          `<strong>${escapeHtml(ws)}</strong> has hit the free-tier cap of 10,000 tasks. The ingest endpoint is now returning ${emailCode("429 plan_quota_exceeded")}.`,
        ),
        emailParagraph(
          `You've ingested <strong>${tasks.toLocaleString()}</strong> inbound events this month. Upgrade to Pro to resume immediately — $20/month covers about 1.33M events, then $0.015 per 1,000.`,
        ),
        emailButton(billingUrl(), "Upgrade to Pro — $20/month"),
      ].join(""),
    ),
  }),
  payment_failed: ({ workspaceName: ws }) => ({
    text: [
      `Stripe couldn't charge the card on file for ${ws}.`,
      ``,
      `Ingest is still flowing while Stripe retries. To avoid suspension, update your payment method:`,
      ``,
      `${billingUrl()}`,
      emailTextSignature(`Manage notification settings: ${notificationsUrl()}`),
    ].join("\n"),
    html: billingHtml(
      ws,
      `We couldn't charge your card — update it to avoid suspension.`,
      [
        emailHeading("Payment failed"),
        emailParagraph(
          `Stripe couldn't charge the card on file for <strong>${escapeHtml(ws)}</strong>.`,
        ),
        emailParagraph(
          `Ingest is still flowing while Stripe retries. To avoid suspension, update your payment method.`,
        ),
        emailButton(billingUrl(), "Update payment method"),
      ].join(""),
    ),
  }),
  billing_suspended: ({ workspaceName: ws }) => ({
    text: [
      `${ws} has been suspended for non-payment. The ingest endpoint is returning 402 to new webhooks.`,
      ``,
      `Update your payment method to restore service:`,
      ``,
      `${billingUrl()}`,
      emailTextSignature(`Manage notification settings: ${notificationsUrl()}`),
    ].join("\n"),
    html: billingHtml(
      ws,
      `Ingest paused for non-payment — update your card to restore service.`,
      [
        emailHeading("Billing suspended — ingest paused"),
        emailParagraph(
          `<strong>${escapeHtml(ws)}</strong> has been suspended for non-payment. The ingest endpoint is returning ${emailCode("402 billing_suspended")}.`,
        ),
        emailParagraph(`Update your payment method to restore service.`),
        emailButton(billingUrl(), "Update payment method"),
      ].join(""),
    ),
  }),
  upcoming_invoice: ({ workspaceName: ws, estimatedCents, periodEndLabel }) => ({
    text: [
      `Heads up: ${ws}'s current billing period${periodEndLabel ? ` ends ${periodEndLabel}` : " is ending soon"}.`,
      ``,
      estimatedCents != null
        ? `Estimated invoice so far: ${dollars(estimatedCents)}. No action needed — we send this so the amount is never a surprise.`
        : `No action needed — we send this so the amount is never a surprise.`,
      ``,
      `Review usage and invoices: ${billingUrl()}`,
      emailTextSignature(`Manage notification settings: ${notificationsUrl()}`),
    ].join("\n"),
    html: billingHtml(
      ws,
      estimatedCents != null
        ? `Estimated so far: ${dollars(estimatedCents)}. No action needed — just a heads up.`
        : `No action needed — just a heads up on your upcoming invoice.`,
      [
        emailHeading("Your upcoming invoice"),
        emailParagraph(
          `Heads up: <strong>${escapeHtml(ws)}</strong>'s current billing period${periodEndLabel ? ` ends <strong>${escapeHtml(periodEndLabel)}</strong>` : " is ending soon"}.`,
        ),
        emailParagraph(
          estimatedCents != null
            ? `Estimated invoice so far: <strong>${dollars(estimatedCents)}</strong>. No action needed — we send this so the amount is never a surprise.`
            : `No action needed — we send this so the amount is never a surprise.`,
        ),
        emailButton(billingUrl(), "Review usage & invoices"),
      ].join(""),
    ),
  }),
  usage_spike: ({ workspaceName: ws, tasksThisPeriod: tasks, estimatedCents }) => ({
    text: [
      `${ws} is on track to use noticeably more than last month — ${tasks.toLocaleString()} tasks so far this period.`,
      ``,
      estimatedCents != null
        ? `At this rate the estimated invoice is around ${dollars(estimatedCents)}. If that's expected, there's nothing to do.`
        : `If that's expected, there's nothing to do — we just wanted you to see it early.`,
      ``,
      `Review usage: ${billingUrl()}`,
      emailTextSignature(`Manage notification settings: ${notificationsUrl()}`),
    ].join("\n"),
    html: billingHtml(
      ws,
      estimatedCents != null
        ? `On track for ~${dollars(estimatedCents)} this period — take a look if that's unexpected.`
        : `Usage is trending higher than last month — take a look if that's unexpected.`,
      [
        emailHeading("Usage is running higher than last month"),
        emailParagraph(
          `<strong>${escapeHtml(ws)}</strong> is on track to use noticeably more than last month — <strong>${tasks.toLocaleString()}</strong> tasks so far this period.`,
        ),
        emailParagraph(
          estimatedCents != null
            ? `At this rate the estimated invoice is around <strong>${dollars(estimatedCents)}</strong>. If that's expected, there's nothing to do.`
            : `If that's expected, there's nothing to do — we just wanted you to see it early.`,
        ),
        emailButton(billingUrl(), "Review usage"),
      ].join(""),
    ),
  }),
};

export async function sendBillingEmail(
  args: SendBillingEmailArgs,
  deps: SendBillingEmailDeps = {},
): Promise<{ sent: boolean; recipients: number; deduped: boolean }> {
  const pg = deps.pg ?? db();
  const periodStartKey = currentPeriodStartUtc();
  const idempotencyId = `axl_email:${args.workspaceId}:${args.kind}:${periodStartKey}`;

  // Idempotency: same INSERT-ON-CONFLICT trick as Stripe webhooks. The row
  // retains only its id, type, workspace, and processing metadata.
  const insert = await pg.query<{ id: string }>(
    `INSERT INTO billing_events (id, type, workspace_id, payload)
     VALUES ($1, $2, $3, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [idempotencyId, `email.${args.kind}`, args.workspaceId],
  );
  if (insert.rows.length === 0) {
    // Already emailed this (workspace, kind, period) — the idempotency journal
    // has the row. `deduped` lets the dispatcher know NOT to re-emit the in-app
    // notification (it was emitted on the first cross this period).
    return { sent: false, recipients: 0, deduped: true };
  }

  // Find owner + admin emails — only those roles get billing notices.
  const recipients = await pg.query<{ email: string }>(
    `SELECT DISTINCT u.email
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
      WHERE wm.workspace_id = $1
        AND wm.role IN ('owner', 'admin')`,
    [args.workspaceId],
  );
  if (recipients.rows.length === 0) {
    // Still mark processed so we don't retry indefinitely.
    await pg.query(
      `UPDATE billing_events SET processed_at = now(), error = 'no_recipients' WHERE id = $1`,
      [idempotencyId],
    );
    return { sent: false, recipients: 0, deduped: false };
  }

  const subject = SUBJECTS[args.kind](args.workspaceName);
  const { text, html } = BODIES[args.kind](args);

  const results = await Promise.all(
    recipients.rows.map((r) =>
      sendEmail({ to: r.email, subject, html, text }).catch(() => ({
        ok: false,
        error: "email_delivery_failed",
      })),
    ),
  );
  const failures = results.filter((r) => !r.ok).map((r) => ("error" in r ? r.error : "unknown"));
  await pg.query(
    `UPDATE billing_events
        SET processed_at = now(),
            error = $2
      WHERE id = $1`,
    [idempotencyId, failures.length > 0 ? failures.join("; ").slice(0, 500) : null],
  );
  return { sent: failures.length < results.length, recipients: results.length, deduped: false };
}

function appUrl(): string {
  return appBaseUrl();
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function currentPeriodStartUtc(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .slice(0, 10);
}

function billingUrl(): string {
  return `${appUrl()}/settings?tab=billing`;
}

function notificationsUrl(): string {
  return `${appUrl()}/settings?tab=notifications`;
}

/** Wrap billing content in the shared branded shell with a billing-specific footer. */
function billingHtml(ws: string, preheader: string, contentHtml: string): string {
  return renderBrandedEmail({
    preheader,
    contentHtml,
    footerNote: `You receive billing notices as an owner or admin of <strong>${escapeHtml(ws)}</strong>. ${emailLink(notificationsUrl(), "Manage notification settings")}.`,
  });
}
