"use server";

// Auth server actions: signup, signin, signout, password reset, email verification.

import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, withTransaction } from "./db";
import { sendEmail } from "./email";
import { renderWelcomeEmail } from "./welcome-email";
import {
  emailButton,
  emailHeading,
  emailLinkFallback,
  emailNote,
  emailParagraph,
  emailTextSignature,
  renderBrandedEmail,
} from "./email-layout";
import { prefixedId, slugifyWorkspaceName } from "./ids";
import { hashPassword, validatePassword, verifyPassword } from "./passwords";
import {
  findValidResetToken,
  issuePasswordResetToken,
  markResetTokenUsed,
  revokeAllSessionsForUser,
} from "./password-reset";
import {
  findValidEmailVerificationToken,
  markEmailVerificationUsed,
} from "./email-verification";
import { safeReturnTo } from "./return-to";
import { createSession, destroySession } from "./session";
import { CURRENT_TERMS_VERSION, acceptedDocumentVersions } from "./legal";
import { captureServerEvent } from "./posthog-server";
import { enforceAuthRateLimits, rateLimitMessage } from "./rate-limit";
import { sendAdminSignupAlert } from "./admin-signup-alert";
import { writeAudit } from "./audit";
import { formValue } from "./form";
import { appBaseUrl } from "./app-url";
import { requestIpFromHeaders } from "./request-ip";
import { normalizeEmail, tokenHash, detectWorkspaceTimezone } from "./account-shared";
import type { ActionState } from "./action-data";
import { sendVerificationEmail } from "./email-verification-resend";

/**
 * Returned for EVERY non-invite signup submission — whether the address was
 * new or already registered — so the form can't be used to enumerate which
 * emails have accounts (mirrors PASSWORD_RESET_GENERIC_NOTICE). The fork
 * happens in the mailbox instead: new addresses get a verification link,
 * already-registered ones get a "you already have an account" note. Both
 * branches do one users lookup plus one email send, so timing stays roughly
 * comparable — same convention as the reset flow, which also doesn't pad.
 */
const SIGNUP_GENERIC_NOTICE =
  "Check your email — we sent the next step to that address. New-account verification links expire in 24 hours.";

/**
 * Sent to the EXISTING account owner when someone submits their address on
 * the public signup form — the same pattern requestPasswordReset uses, so the
 * form response can stay identical for known and unknown emails.
 */
async function sendAccountExistsEmail(email: string): Promise<void> {
  const signInLink = `${appBaseUrl()}/login`;
  const resetLink = `${appBaseUrl()}/forgot`;
  const subject = "You already have an Axel account";
  const text = [
    "Someone (hopefully you) tried to create an Axel account with this email — but it already has one.",
    "",
    "If that was you, just sign in:",
    signInLink,
    "",
    "Forgot your password? Request a reset link:",
    resetLink,
    "",
    "If this wasn't you, you can ignore this email; nothing about your account has changed.",
    emailTextSignature(),
  ].join("\n");
  const html = renderBrandedEmail({
    preheader: "This address already has an Axel account — sign in instead.",
    contentHtml: [
      emailHeading("You already have an account"),
      emailParagraph("Someone (hopefully you) tried to create an Axel account with this email — but it already has one."),
      emailParagraph("If that was you, just sign in with your existing password."),
      emailButton(signInLink, "Sign in"),
      emailParagraph(`Forgot your password? <a href="${resetLink}">Request a reset link</a>.`),
      emailNote("If this wasn't you, you can ignore this email — nothing about your account has changed."),
    ].join(""),
  });
  const sent = await sendEmail({ to: email, subject, html, text });
  if (!sent.ok) {
    console.error("[sendAccountExistsEmail] email failed:", sent.error);
  }
}

export async function signUp(_state: ActionState, formData: FormData): Promise<ActionState> {
  const name = formValue(formData, "name");
  const email = normalizeEmail(formValue(formData, "email"));
  const workspaceName = formValue(formData, "workspaceName");
  const password = formValue(formData, "password");
  const inviteToken = formValue(formData, "inviteToken");

  if (!name || !email || !password || (!workspaceName && !inviteToken)) return { error: "Complete all required fields." };
  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };
  if (!formData.get("acceptTerms")) {
    return { error: "You must agree to the Terms of Service, Acceptable Use Policy, and Privacy Policy to create an account." };
  }

  // Both buckets are charged BEFORE the account-existence check so a breach
  // reads the same whether or not the email is registered. The per-email
  // bucket also caps how often the "you already have an account" note can be
  // aimed at one inbox (mirrors pwreset:email).
  const signUpBreach = await enforceAuthRateLimits([
    [`signup:ip:${(await getRequestIp()) ?? "unknown"}`, 5, 60 * 60_000],
    [`signup:email:${email}`, 5, 60 * 60_000],
  ]);
  if (signUpBreach) return { error: rateLimitMessage(signUpBreach) };

  // Evidence captured for the clickwrap consent record (terms_acceptances).
  const acceptanceIp = (await getRequestIp()) ?? null;
  const acceptanceUserAgent = (await headers()).get("user-agent");

  const timezone = await detectWorkspaceTimezone(formData);

  let signup: {
    userId: string;
    workspaceId: string;
    workspaceName: string;
    viaInvite: boolean;
  };
  try {
    signup = await withTransaction(async (client) => {
      const existing = await client.query("SELECT id FROM users WHERE lower(email) = lower($1)", [email]);
      if (existing.rowCount) throw new Error("email_taken");

      const invite = inviteToken
        ? await client.query<{
          id: string;
          workspace_id: string;
          workspace_name: string;
          email: string;
          role: "admin" | "member";
        }>(
          `SELECT wi.id, wi.workspace_id, w.name AS workspace_name, wi.email, wi.role
             FROM workspace_invites wi
             JOIN workspaces w ON w.id = wi.workspace_id
            WHERE wi.token_hash = $1
              AND wi.accepted_at IS NULL
              AND wi.expires_at > now()
            LIMIT 1`,
          [tokenHash(inviteToken)],
        )
        : null;
      const inviteRecord = invite?.rows[0];
      if (inviteToken && !inviteRecord) throw new Error("invalid_invite");
      if (inviteRecord && inviteRecord.email.toLowerCase() !== email) throw new Error("invite_email_mismatch");

      const nextUserId = prefixedId("usr");
      // An invite token was emailed to this exact address (and the address
      // must match the invite), so accepting one already proves mailbox
      // ownership — those accounts are born verified. Public signups start
      // unverified and confirm via the emailed token (see verifyEmail).
      await client.query(
        `INSERT INTO users (id, email, name, password_hash, email_verified_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [nextUserId, email, name, hashPassword(password), inviteRecord ? new Date().toISOString() : null],
      );

      let signupWorkspaceId: string;
      if (inviteRecord) {
        signupWorkspaceId = inviteRecord.workspace_id;
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES ($1, $2, $3)`,
          [inviteRecord.workspace_id, nextUserId, inviteRecord.role],
        );
        await client.query(
          `UPDATE workspace_invites
              SET accepted_by_user_id = $1, accepted_at = now()
            WHERE id = $2`,
          [nextUserId, inviteRecord.id],
        );
        await writeAudit(client, {
          workspaceId: inviteRecord.workspace_id,
          actorUserId: nextUserId,
          action: "member.joined",
          targetType: "user",
          targetId: nextUserId,
        });
      } else {
        const workspaceId = prefixedId("ws");
        signupWorkspaceId = workspaceId;
        await client.query(
          `INSERT INTO workspaces (id, name, slug, timezone)
           VALUES ($1, $2, $3, $4)`,
          [
            workspaceId,
            workspaceName,
            `${slugifyWorkspaceName(workspaceName)}-${randomBytes(3).toString("hex")}`,
            timezone,
          ],
        );
        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role)
           VALUES ($1, $2, 'owner')`,
          [workspaceId, nextUserId],
        );
        await writeAudit(client, {
          workspaceId,
          actorUserId: nextUserId,
          action: "workspace.created",
          targetType: "workspace",
          targetId: workspaceId,
        });
      }

      // Durable proof of clickwrap consent — which document versions were
      // agreed to, plus the IP/user-agent/timestamp evidence. See migration 0051.
      await client.query(
        `INSERT INTO terms_acceptances
           (id, user_id, workspace_id, terms_version, document_versions, context, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          prefixedId("tac"),
          nextUserId,
          signupWorkspaceId,
          CURRENT_TERMS_VERSION,
          JSON.stringify(acceptedDocumentVersions()),
          inviteRecord ? "invite_signup" : "signup",
          acceptanceIp,
          acceptanceUserAgent,
        ],
      );
      return {
        userId: nextUserId,
        workspaceId: signupWorkspaceId,
        workspaceName: inviteRecord?.workspace_name ?? workspaceName,
        viaInvite: Boolean(inviteRecord),
      };
    });
  } catch (err) {
    if (err instanceof Error && err.message === "email_taken") {
      if (inviteToken) {
        // Invite signups may see the explicit error: the invite token was
        // emailed to this exact address, so there's no enumeration to leak.
        return { error: "That email already has an account." };
      }
      // Public form: identical notice for known and unknown emails — the
      // account owner gets a "you already have an account" note instead of
      // the form leaking existence (same pattern as requestPasswordReset).
      try {
        await sendAccountExistsEmail(email);
      } catch (emailErr) {
        console.error("[signup] account-exists email threw", emailErr);
      }
      return { notice: SIGNUP_GENERIC_NOTICE };
    }
    if (err instanceof Error && err.message === "invalid_invite") return { error: "That invite is invalid or expired." };
    if (err instanceof Error && err.message === "invite_email_mismatch") return { error: "That invite was issued for a different email." };
    return { error: "Could not create the account. Check database configuration and try again." };
  }

  const signupAlert = await sendAdminSignupAlert({
    userId: signup.userId,
    userName: name,
    userEmail: email,
    workspaceId: signup.workspaceId,
    workspaceName: signup.workspaceName,
    viaInvite: signup.viaInvite,
  });
  if (signupAlert.errors.length > 0) {
    console.error("[signup] admin notification email failed", signupAlert.errors);
  }

  // Backend-side signup event: the browser SDK isn't loaded during the server
  // action, so capture it here and set the person's email/name. Analytics
  // failures must never block or fail a successful signup.
  try {
    await captureServerEvent({
      distinctId: signup.userId,
      event: "user signed up",
      properties: { $set: { email, name }, via_invite: signup.viaInvite },
      groups: { workspace: signup.workspaceId },
    });
  } catch {
    // non-fatal
  }

  if (!signup.viaInvite) {
    // Welcome email — what Axel is, and the three steps to a first event. Only
    // for people starting a NEW workspace: someone accepting an invite is
    // joining a workspace that may already be delivering, so "create your first
    // source" would be wrong for them.
    //
    // Best-effort by design: the account is committed at this point, so an email
    // failure must never surface as a signup error.
    try {
      const welcome = renderWelcomeEmail({ name });
      const sent = await sendEmail({
        to: email,
        subject: welcome.subject,
        html: welcome.html,
        text: welcome.text,
      });
      if (!sent.ok) console.error("[signup] welcome email failed", sent.error);
    } catch (err) {
      console.error("[signup] welcome email threw", err);
    }

    // Verification link — confirming it stamps users.email_verified_at and
    // signs the user in (see verifyEmail). Also best-effort: if the send
    // fails the user can still sign in with their password and resend from
    // the dashboard's verify banner.
    try {
      await sendVerificationEmail(signup.userId, email);
    } catch (err) {
      console.error("[signup] verification email threw", err);
    }

    // No session and no redirect here: the response is the SAME generic
    // notice the already-registered branch returns, so signup output can't
    // be used to enumerate accounts. The Google-Ads conversion marker moves
    // to verifyEmail, where the first authenticated page follows.
    return { notice: SIGNUP_GENERIC_NOTICE };
  }

  // Invite path — mailbox ownership was proven by the emailed invite token,
  // so the account is created verified and signed in immediately.
  //
  // The account + workspace + clickwrap are committed. A session-write failure
  // here must NOT fall into the "email taken" / "Could not create the account"
  // path above and strand a committed, un-loggable account — redirect to
  // sign-in so the user can authenticate with the credentials they just set.
  try {
    await createSession(signup.userId);
  } catch {
    redirect("/login?created=1");
  }

  await setSignupConversionCookie();

  redirect("/dashboard");
}

/**
 * Let the first authenticated page report the completed account creation to
 * Google Ads. The short-lived marker is cleared by the client immediately
 * after gtag accepts the event, preventing ordinary dashboard visits from
 * generating duplicate conversions. Set when a session is actually minted
 * (invite signup, or email verification for public signups) — never on the
 * public signup response itself, where a Set-Cookie that only appears for
 * new addresses would leak account existence.
 */
async function setSignupConversionCookie(): Promise<void> {
  const cookieJar = await cookies();
  cookieJar.set("axel_signup_conversion", "1", {
    httpOnly: false,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60,
  });
}

// A valid pbkdf2 hash of a random throwaway secret, computed once. When the
// email is unknown we still run verifyPassword against THIS so the response time
// is the same whether or not the account exists — closing the user-enumeration
// timing oracle (verifyPassword short-circuits before pbkdf2 on a malformed
// hash, so we need a well-formed dummy to do the equivalent work).
const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(32).toString("hex"));

export async function signIn(_state: ActionState, formData: FormData): Promise<ActionState> {
  const email = normalizeEmail(formValue(formData, "email"));
  const password = formValue(formData, "password");
  if (!email || !password) return { error: "Enter email and password." };

  const signInBreach = await enforceAuthRateLimits([
    [`signin:ip:${(await getRequestIp()) ?? "unknown"}`, 10, 15 * 60_000],
    [`signin:email:${email}`, 5, 15 * 60_000],
  ]);
  if (signInBreach) return { error: rateLimitMessage(signInBreach) };

  const result = await db().query<{ id: string; password_hash: string }>(
    "SELECT id, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1",
    [email],
  );
  const user = result.rows[0];
  // Always run verifyPassword (against the dummy hash for an unknown email) so
  // timing doesn't leak account existence. `&& user` ensures an unknown email
  // can never authenticate even in the unreachable case of a dummy-hash match.
  const passwordOk = verifyPassword(password, user?.password_hash ?? DUMMY_PASSWORD_HASH) && Boolean(user);
  if (!passwordOk) {
    return { error: "Invalid email or password." };
  }
  await createSession(user!.id);
  // Land the user back on the page that forced them to /login (auth-gate
  // redirects carry it as ?returnTo, threaded through the form). Re-validated
  // here — the hidden field is client-controlled — so only a same-origin
  // relative path can ever be honored. Anything else falls back to /dashboard.
  const returnTo = safeReturnTo(formValue(formData, "returnTo"));
  redirect(returnTo ?? "/dashboard");
}

export async function logOut(): Promise<void> {
  await destroySession();
  redirect("/login");
}

async function getRequestIp(): Promise<string | null> {
  return requestIpFromHeaders(await headers());
}

const PASSWORD_RESET_GENERIC_NOTICE =
  "If an account exists for that email, we sent a password-reset link. Check your inbox (and spam) — the link expires in 30 minutes.";

export async function requestPasswordReset(_state: ActionState, formData: FormData): Promise<ActionState> {
  const email = normalizeEmail(formValue(formData, "email"));
  if (!email) return { error: "Enter your email." };

  const resetReqBreach = await enforceAuthRateLimits([
    [`pwreset:ip:${(await getRequestIp()) ?? "unknown"}`, 5, 60 * 60_000],
    [`pwreset:email:${email}`, 5, 60 * 60_000],
  ]);
  if (resetReqBreach) return { error: rateLimitMessage(resetReqBreach) };

  // Always return the same notice so the form can't be used to enumerate
  // which emails are registered.
  const result = await db().query<{ id: string }>(
    "SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1",
    [email],
  );
  const user = result.rows[0];
  if (!user) return { notice: PASSWORD_RESET_GENERIC_NOTICE };

  try {
    const ip = await getRequestIp();
    const { token } = await issuePasswordResetToken(user.id, ip);
    const link = `${appBaseUrl()}/reset?token=${encodeURIComponent(token)}`;
    const subject = "Reset your Axel password";
    const text = [
      "Someone (hopefully you) requested a password reset for your Axel account.",
      "",
      `Open this link to choose a new password — it expires in 30 minutes:`,
      link,
      "",
      "If you didn't request this, you can ignore this email; your password won't change.",
      emailTextSignature(),
    ].join("\n");
    const html = renderBrandedEmail({
      preheader: "Choose a new password — this link expires in 30 minutes.",
      contentHtml: [
        emailHeading("Reset your password"),
        emailParagraph("Someone (hopefully you) requested a password reset for your Axel account."),
        emailParagraph("Choose a new password using the button below — the link expires in 30 minutes."),
        emailButton(link, "Reset password"),
        emailLinkFallback(link),
        emailNote("If you didn't request this, you can ignore this email — your password won't change."),
      ].join(""),
    });
    const sent = await sendEmail({ to: email, subject, html, text });
    if (!sent.ok) {
      console.error("[requestPasswordReset] email failed:", sent.error);
    }
  } catch (err) {
    console.error("[requestPasswordReset] token issue failed:", err);
  }
  return { notice: PASSWORD_RESET_GENERIC_NOTICE };
}

export async function resetPassword(_state: ActionState, formData: FormData): Promise<ActionState> {
  const token = formValue(formData, "token");
  const password = formValue(formData, "password");
  const confirm = formValue(formData, "confirm");

  if (!token) return { error: "Reset link is missing or malformed." };
  if (!password || !confirm) return { error: "Enter and confirm your new password." };
  if (password !== confirm) return { error: "The passwords don't match." };

  const passwordError = validatePassword(password);
  if (passwordError) return { error: passwordError };

  const resetSubmitBreach = await enforceAuthRateLimits([
    [`pwreset-submit:ip:${(await getRequestIp()) ?? "unknown"}`, 10, 15 * 60_000],
  ]);
  if (resetSubmitBreach) return { error: rateLimitMessage(resetSubmitBreach) };

  const lookup = await findValidResetToken(token);
  if (!lookup) return { error: "This reset link has expired or already been used. Request a new one." };

  try {
    await withTransaction(async (client) => {
      await client.query(
        "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
        [hashPassword(password), lookup.user_id],
      );
      await markResetTokenUsed(lookup.reset_id, client);
      await revokeAllSessionsForUser(lookup.user_id, client);
      await writeAudit(client, {
        workspaceId: null,
        actorUserId: lookup.user_id,
        action: "user.password_reset",
        targetType: "user",
        targetId: lookup.user_id,
      });
    });
  } catch (err) {
    console.error("[resetPassword] transaction failed:", err);
    return { error: "Could not reset password. Try again — if it keeps failing, request a fresh link." };
  }

  await createSession(lookup.user_id);
  redirect("/dashboard");
}

/**
 * Consume an email-verification token (from the /verify page's confirm
 * button — a POST, so mail scanners prefetching the GET link can't burn the
 * token). Stamps users.email_verified_at, then signs the user in: for public
 * signups this is the moment the account becomes usable, mirroring how
 * resetPassword ends in a session.
 */
export async function verifyEmail(_state: ActionState, formData: FormData): Promise<ActionState> {
  const token = formValue(formData, "token");
  if (!token) return { error: "Verification link is missing or malformed." };

  const verifySubmitBreach = await enforceAuthRateLimits([
    [`verify-submit:ip:${(await getRequestIp()) ?? "unknown"}`, 10, 15 * 60_000],
  ]);
  if (verifySubmitBreach) return { error: rateLimitMessage(verifySubmitBreach) };

  const lookup = await findValidEmailVerificationToken(token);
  if (!lookup) {
    return { error: "This verification link has expired or already been used. Sign in and use “Resend email” to get a fresh one." };
  }

  let firstVerification = false;
  try {
    await withTransaction(async (client) => {
      await markEmailVerificationUsed(lookup.verification_id, client);
      // Conditional on IS NULL so a later token can never move an existing
      // verification timestamp; rowCount tells us whether THIS confirmation
      // was the one that verified the account.
      const updated = await client.query(
        `UPDATE users
            SET email_verified_at = now(), updated_at = now()
          WHERE id = $1 AND email_verified_at IS NULL`,
        [lookup.user_id],
      );
      firstVerification = updated.rowCount === 1;
      await writeAudit(client, {
        workspaceId: null,
        actorUserId: lookup.user_id,
        action: "user.email_verified",
        targetType: "user",
        targetId: lookup.user_id,
      });
    });
  } catch (err) {
    console.error("[verifyEmail] transaction failed:", err);
    return { error: "Could not verify your email. Try again — if it keeps failing, sign in and resend the link." };
  }

  await createSession(lookup.user_id);
  if (firstVerification) {
    // Completed public signup — the next page load is the first authenticated
    // one, so the Google-Ads conversion marker belongs here (see signUp).
    await setSignupConversionCookie();
  }
  redirect("/dashboard");
}
