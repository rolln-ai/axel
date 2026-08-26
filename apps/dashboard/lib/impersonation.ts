import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./db";
import { prefixedId } from "./ids";
import { SESSION_COOKIE, hashToken } from "./session";

/**
 * Impersonation primitive used by `lib/admin-actions.ts`.
 *
 * Model: insert a new row into `user_sessions` with `user_id = target` and
 * `impersonator_user_id = admin`, then swap the `axel_session` cookie. The
 * row's `impersonator_returns_to_session_id` points at the admin's prior
 * session so "Stop impersonating" can restore it. TTL is intentionally short
 * (1 hour) so a forgotten impersonation doesn't linger.
 *
 * Refusals are caller-side: `lib/admin-actions.ts` checks (a) the calling
 * session is not already impersonating, and (b) the target user is not a
 * super-admin. This module is the dumb mechanism; policy lives upstream.
 */

const IMPERSONATION_TTL_MINUTES = 60;

export interface ImpersonationStartResult {
  newSessionId: string;
  expiresAt: Date;
}

export async function startImpersonation(args: {
  targetUserId: string;
  adminUserId: string;
  adminSessionId: string;
}): Promise<ImpersonationStartResult> {
  const { targetUserId, adminUserId, adminSessionId } = args;
  const token = randomBytes(32).toString("base64url");
  const sessionId = prefixedId("sess");
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60 * 1000);

  await db().query(
    `INSERT INTO user_sessions
       (id, user_id, session_token_hash, expires_at,
        impersonator_user_id, impersonator_returns_to_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      sessionId,
      targetUserId,
      hashToken(token),
      expiresAt.toISOString(),
      adminUserId,
      adminSessionId,
    ],
  );

  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  return { newSessionId: sessionId, expiresAt };
}

export interface ImpersonationStopResult {
  /** True if a fresh admin session was issued and the cookie was set. */
  restored: boolean;
  /** The impersonated session that was deleted, by id. */
  endedSessionId: string;
  /** The admin user_id whose session was reissued, when restored. */
  adminUserId: string | null;
}

/**
 * Reverse an impersonation. We delete the impersonated session row and — since
 * we can't recover the admin's original plaintext cookie from its hash —
 * issue a *fresh* session row for the admin and set the cookie to that. This
 * is functionally equivalent to logging the admin back in without a password
 * round-trip, which is acceptable because they were already authenticated at
 * the moment they started the impersonation.
 *
 * If the impersonator user no longer exists (e.g. deleted out from under
 * themselves), we just clear the cookie and the UI should redirect to /login.
 */
export async function stopImpersonation(args: {
  currentSessionTokenHash: string;
}): Promise<ImpersonationStopResult> {
  const { currentSessionTokenHash } = args;

  const currentResult = await db().query<{
    id: string;
    impersonator_user_id: string | null;
  }>(
    `SELECT id, impersonator_user_id
       FROM user_sessions
      WHERE session_token_hash = $1
        AND expires_at > now()
      LIMIT 1`,
    [currentSessionTokenHash],
  );
  const current = currentResult.rows[0];
  const jar = await cookies();

  if (!current) {
    jar.delete(SESSION_COOKIE);
    return { restored: false, endedSessionId: "", adminUserId: null };
  }

  await db().query("DELETE FROM user_sessions WHERE id = $1", [current.id]);

  if (!current.impersonator_user_id) {
    jar.delete(SESSION_COOKIE);
    return { restored: false, endedSessionId: current.id, adminUserId: null };
  }

  // Confirm the admin user still exists before issuing a new session.
  const adminResult = await db().query<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 LIMIT 1`,
    [current.impersonator_user_id],
  );
  if (!adminResult.rows[0]) {
    jar.delete(SESSION_COOKIE);
    return { restored: false, endedSessionId: current.id, adminUserId: null };
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db().query(
    `INSERT INTO user_sessions (id, user_id, session_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [prefixedId("sess"), current.impersonator_user_id, hashToken(token), expiresAt.toISOString()],
  );
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });

  return {
    restored: true,
    endedSessionId: current.id,
    adminUserId: current.impersonator_user_id,
  };
}

/** Compute the SHA-256 hash for the caller's current axel_session cookie value. */
export async function currentSessionTokenHash(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  return token ? hashToken(token) : null;
}
