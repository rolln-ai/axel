"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ActionState } from "./action-data";
import {
  ADMIN_MFA_ENROLLMENT_MINUTES,
  decryptAdminMfaSecret,
  encryptAdminMfaSecret,
  generateTotpSecret,
  getAdminMfaMethod,
  verifyTotpCode,
} from "./admin-mfa";
import { writeAudit } from "./audit";
import { db, withTransaction } from "./db";
import { enforceAuthRateLimits, rateLimitMessage } from "./rate-limit";
import { formValue } from "./form";
import { currentSessionTokenHash } from "./impersonation";
import { verifyPassword } from "./passwords";
import { requestIpFromHeaders } from "./request-ip";
import { safeReturnTo } from "./return-to";
import { getAuthenticatedUser } from "./session";

async function requireAdminIdentity() {
  const auth = await getAuthenticatedUser();
  if (!auth) redirect("/login?returnTo=%2Fadmin");
  if (!auth.user.isSuperAdmin || auth.impersonator) redirect("/dashboard");
  return auth;
}

function challengePath(returnTo: string | null): string {
  const safe = safeReturnTo(returnTo);
  return safe ? `/admin-mfa?returnTo=${encodeURIComponent(safe)}` : "/admin-mfa";
}

function completionPath(returnTo: string | null): string {
  return safeReturnTo(returnTo) ?? "/admin";
}

async function enforceMfaRateLimit(userId: string): Promise<string | null> {
  const ip = requestIpFromHeaders(await headers()) ?? "unknown";
  const breach = await enforceAuthRateLimits([
    [`admin-mfa:user:${userId}`, 8, 15 * 60_000],
    [`admin-mfa:ip:${ip}`, 20, 15 * 60_000],
  ]);
  return breach ? rateLimitMessage(breach) : null;
}

export async function beginAdminMfaEnrollmentAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireAdminIdentity();
  const password = formValue(formData, "password");
  const returnTo = formValue(formData, "returnTo");
  if (!password) return { error: "Enter your current password." };

  const limited = await enforceMfaRateLimit(auth.user.id);
  if (limited) return { error: limited };

  const existing = await getAdminMfaMethod(auth.user.id);
  if (existing?.enabledAt) redirect(challengePath(returnTo));
  const sessionTokenHash = await currentSessionTokenHash();
  if (!sessionTokenHash) redirect("/login?returnTo=%2Fadmin");

  const result = await db().query<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE id = $1 LIMIT 1",
    [auth.user.id],
  );
  const passwordHash = result.rows[0]?.password_hash;
  if (!passwordHash || !verifyPassword(password, passwordHash)) {
    return { error: "Password verification failed." };
  }

  try {
    const secret = generateTotpSecret();
    const ciphertext = await encryptAdminMfaSecret(secret, auth.user.id);
    const enrollmentExpiresAt = new Date(
      Date.now() + ADMIN_MFA_ENROLLMENT_MINUTES * 60_000,
    ).toISOString();
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO admin_mfa_methods
           (user_id, secret_ciphertext, enabled_at, last_used_counter,
            enrollment_session_token_hash, enrollment_expires_at, updated_at)
         VALUES ($1, $2, NULL, NULL, $3, $4, now())
         ON CONFLICT (user_id) DO UPDATE
           SET secret_ciphertext = EXCLUDED.secret_ciphertext,
               enabled_at = NULL,
               last_used_counter = NULL,
               enrollment_session_token_hash = EXCLUDED.enrollment_session_token_hash,
               enrollment_expires_at = EXCLUDED.enrollment_expires_at,
               updated_at = now()
         WHERE admin_mfa_methods.enabled_at IS NULL`,
        [auth.user.id, ciphertext, sessionTokenHash, enrollmentExpiresAt],
      );
      await writeAudit(client, {
        workspaceId: null,
        actorUserId: auth.user.id,
        action: "admin.mfa.enrollment_started",
        targetType: "user",
        targetId: auth.user.id,
      });
    });
  } catch {
    console.error("[admin-mfa] enrollment setup failed");
    return { error: "Could not start authenticator setup. Check the server encryption key and try again." };
  }

  redirect(challengePath(returnTo));
}

export async function verifyAdminMfaAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireAdminIdentity();
  const code = formValue(formData, "code");
  const returnTo = formValue(formData, "returnTo");
  if (!code) return { error: "Enter the six-digit authenticator code." };

  const limited = await enforceMfaRateLimit(auth.user.id);
  if (limited) return { error: limited };
  const sessionTokenHash = await currentSessionTokenHash();
  if (!sessionTokenHash) redirect("/login?returnTo=%2Fadmin");

  try {
    await withTransaction(async (client) => {
      const result = await client.query<{
        secret_ciphertext: Buffer;
        enabled_at: string | null;
        last_used_counter: string | null;
        enrollment_valid: boolean;
      }>(
        `SELECT secret_ciphertext,
                enabled_at::text AS enabled_at,
                last_used_counter::text AS last_used_counter,
                (enabled_at IS NOT NULL OR
                  (enrollment_session_token_hash = $2 AND enrollment_expires_at > now()))
                  AS enrollment_valid
           FROM admin_mfa_methods
          WHERE user_id = $1
          FOR UPDATE`,
        [auth.user.id, sessionTokenHash],
      );
      const method = result.rows[0];
      if (!method) throw new Error("mfa_not_enrolled");
      if (!method.enrollment_valid) throw new Error("mfa_enrollment_expired");

      const secret = await decryptAdminMfaSecret(method.secret_ciphertext, auth.user.id);
      const counter = verifyTotpCode(secret, code);
      if (counter === null) throw new Error("mfa_invalid_code");
      const lastCounter = method.last_used_counter === null ? null : Number(method.last_used_counter);
      if (lastCounter !== null && counter <= lastCounter) throw new Error("mfa_replayed_code");

      await client.query(
        `UPDATE admin_mfa_methods
            SET enabled_at = COALESCE(enabled_at, now()),
                last_used_counter = $2,
                enrollment_session_token_hash = NULL,
                enrollment_expires_at = NULL,
                updated_at = now()
          WHERE user_id = $1`,
        [auth.user.id, counter],
      );
      const updated = await client.query(
        `UPDATE user_sessions
            SET admin_mfa_verified_at = now()
          WHERE session_token_hash = $1
            AND user_id = $2
            AND expires_at > now()
            AND impersonator_user_id IS NULL`,
        [sessionTokenHash, auth.user.id],
      );
      if (updated.rowCount !== 1) throw new Error("mfa_session_missing");

      await writeAudit(client, {
        workspaceId: null,
        actorUserId: auth.user.id,
        action: method.enabled_at ? "admin.mfa.verified" : "admin.mfa.enabled",
        targetType: "user",
        targetId: auth.user.id,
        metadata: { session_step_up: true },
      });
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "mfa_invalid_code") return { error: "That authenticator code is invalid." };
    if (message === "mfa_replayed_code") return { error: "That code was already used. Wait for the next code." };
    if (message === "mfa_not_enrolled") return { error: "Set up an authenticator before continuing." };
    if (message === "mfa_enrollment_expired") {
      return { error: "Authenticator setup expired or belongs to another session. Confirm your password to restart setup." };
    }
    if (message === "mfa_session_missing") redirect("/login?returnTo=%2Fadmin");
    console.error("[admin-mfa] verification failed");
    return { error: "Could not verify the authenticator code." };
  }

  redirect(completionPath(returnTo));
}
