import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { db } from "./db";
import { prefixedId } from "./ids";

const RESET_TTL_MINUTES = 30;
const MAX_ACTIVE_TOKENS_PER_USER = 3;

function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Issue a new password-reset token for `userId`. Returns the plaintext token
 * the caller should email; only the hash is persisted. Bounded to
 * MAX_ACTIVE_TOKENS_PER_USER unused tokens — older tokens for the same user
 * are pre-cleared so a flood of /forgot submissions can't fill the table.
 */
export async function issuePasswordResetToken(
  userId: string,
  requestedIp: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000);

  await db().query(
    `WITH ranked AS (
       SELECT id,
              row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
         FROM password_resets
        WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
     )
     DELETE FROM password_resets
      WHERE id IN (SELECT id FROM ranked WHERE rn >= $2)`,
    [userId, MAX_ACTIVE_TOKENS_PER_USER],
  );

  await db().query(
    `INSERT INTO password_resets (id, user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [prefixedId("pwr"), userId, hashResetToken(token), expiresAt.toISOString(), requestedIp],
  );

  return { token, expiresAt };
}

export interface ResetTokenLookup {
  user_id: string;
  email: string;
  reset_id: string;
}

/** Look up an unused, unexpired reset token. Returns null if invalid. */
export async function findValidResetToken(token: string): Promise<ResetTokenLookup | null> {
  const rows = await db().query<ResetTokenLookup>(
    `SELECT pr.id AS reset_id, pr.user_id, u.email
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = $1
        AND pr.used_at IS NULL
        AND pr.expires_at > now()
      LIMIT 1`,
    [hashResetToken(token)],
  );
  return rows.rows[0] ?? null;
}

/**
 * Mark a reset token as used so it can't be redeemed twice. Run inside the
 * same transaction that updates `users.password_hash` so a partial commit
 * can't leave the token unspent against a new password.
 */
export async function markResetTokenUsed(resetId: string, client: pg.PoolClient): Promise<void> {
  // Conditional on `used_at IS NULL` so two concurrent requests carrying the
  // same token can't both redeem it (findValidResetToken runs outside this
  // transaction, so its check is racy). The loser updates 0 rows and throws,
  // rolling back its password change — only one request can consume the token.
  const res = await client.query(
    "UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL",
    [resetId],
  );
  if (res.rowCount === 0) {
    throw new Error("reset_token_already_used");
  }
}

/**
 * Drop every active session for a user — called after a successful reset so
 * any attacker holding a stolen session cookie is forced back through login
 * with the new password.
 */
export async function revokeAllSessionsForUser(userId: string, client: pg.PoolClient): Promise<void> {
  await client.query("DELETE FROM user_sessions WHERE user_id = $1", [userId]);
}
