import "server-only";

import { headers } from "next/headers";
import { appBaseUrl } from "./app-url";
import type { ActionState } from "./action-data";
import { db } from "./db";
import { sendEmail, type SendResult } from "./email";
import {
  emailButton,
  emailHeading,
  emailLinkFallback,
  emailNote,
  emailParagraph,
  emailTextSignature,
  renderBrandedEmail,
} from "./email-layout";
import { issueEmailVerificationToken } from "./email-verification";
import { enforceAuthRateLimits, rateLimitMessage } from "./rate-limit";
import { requestIpFromHeaders } from "./request-ip";

/**
 * Issue a fresh verification token and send its link. The result is returned
 * to the caller so an explicit resend can distinguish delivery acceptance
 * from a provider rejection. Signup intentionally treats this as best-effort.
 */
export async function sendVerificationEmail(userId: string, email: string): Promise<SendResult> {
  const requestedIp = requestIpFromHeaders(await headers());
  const { token } = await issueEmailVerificationToken(userId, requestedIp);
  const link = `${appBaseUrl()}/verify?token=${encodeURIComponent(token)}`;
  const subject = "Verify your email for Axel";
  const text = [
    "Confirm this is your email address to finish setting up your Axel account.",
    "",
    "Open this link to verify — it expires in 24 hours:",
    link,
    "",
    "If you didn't create an Axel account, you can ignore this email.",
    emailTextSignature(),
  ].join("\n");
  const html = renderBrandedEmail({
    preheader: "Confirm your email address — this link expires in 24 hours.",
    contentHtml: [
      emailHeading("Verify your email"),
      emailParagraph("Confirm this is your email address to finish setting up your Axel account."),
      emailParagraph("Use the button below — the link expires in 24 hours."),
      emailButton(link, "Verify email"),
      emailLinkFallback(link),
      emailNote("If you didn't create an Axel account, you can ignore this email."),
    ].join(""),
  });
  const sent = await sendEmail({ to: email, subject, html, text });
  if (!sent.ok) {
    console.error("[sendVerificationEmail] email failed");
  }
  return sent;
}

/**
 * Resend for an already-authenticated user. This is shared by the stable API
 * endpoint (used by the banner) and tests, keeping auth transport separate
 * from the rate limit, account lookup, token issue, and provider result.
 */
export async function resendVerificationEmailForUser(userId: string): Promise<ActionState> {
  const resendBreach = await enforceAuthRateLimits([
    [`verify-resend:user:${userId}`, 3, 60 * 60_000],
  ]);
  if (resendBreach) return { error: rateLimitMessage(resendBreach) };

  const result = await db().query<{ email: string; email_verified_at: string | null }>(
    "SELECT email, email_verified_at::text AS email_verified_at FROM users WHERE id = $1 LIMIT 1",
    [userId],
  );
  const user = result.rows[0];
  if (!user) return { error: "Account not found." };
  if (user.email_verified_at) return { notice: "Your email is already verified." };

  try {
    const sent = await sendVerificationEmail(userId, user.email);
    if (!sent.ok) {
      return { error: "Could not send the verification email. Try again." };
    }
  } catch {
    console.error("[resendVerificationEmail] failed");
    return { error: "Could not send the verification email. Try again." };
  }
  return { notice: `Verification email sent to ${user.email}. The link expires in 24 hours.` };
}
