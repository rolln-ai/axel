import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";
import { db } from "./db";
import { prefixedId } from "./ids";

/**
 * Email-verification tokens — proof of mailbox ownership for a signup.
 * Deliberately the same shape and lifecycle as password_resets
 * (lib/password-reset.ts): sha256(token) at rest, single-use via used_at,
 * TTL via expires_at, bounded live tokens per user. Confirming a token
 * populates users.email_verified_at (see verifyEmail in lib/auth-actions.ts).
 */

const VERIFICATION_TTL_HOURS = 24;
const MAX_ACTIVE_TOKENS_PER_USER = 3;

export function hashVerificationToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/**
 * Issue a new email-verification token for `userId`. Returns the plaintext
 * token the caller should email; only the hash is persisted. Bounded to
 * MAX_ACTIVE_TOKENS_PER_USER unused tokens — older tokens for the same user
 * are pre-cleared so repeated "resend" clicks can't fill the table.
 */
export async function issueEmailVerificationToken(
  userId: string,
  requestedIp: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + VERIFICATION_TTL_HOURS * 60 * 60 * 1000);

  await db().query(
    `WITH ranked AS (
       SELECT id,
              row_number() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
         FROM email_verifications
        WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
     )
     DELETE FROM email_verifications
      WHERE id IN (SELECT id FROM ranked WHERE rn >= $2)`,
    [userId, MAX_ACTIVE_TOKENS_PER_USER],
  );

  await db().query(
    `INSERT INTO email_verifications (id, user_id, token_hash, expires_at, requested_ip)
     VALUES ($1, $2, $3, $4, $5)`,
    [prefixedId("evr"), userId, hashVerificationToken(token), expiresAt.toISOString(), requestedIp],
  );

  return { token, expiresAt };
}

export interface VerificationTokenLookup {
  user_id: string;
  email: string;
  verification_id: string;
}

/** Look up an unused, unexpired verification token. Returns null if invalid. */
export async function findValidEmailVerificationToken(
  token: string,
): Promise<VerificationTokenLookup | null> {
  const rows = await db().query<VerificationTokenLookup>(
    `SELECT ev.id AS verification_id, ev.user_id, u.email
       FROM email_verifications ev
       JOIN users u ON u.id = ev.user_id
      WHERE ev.token_hash = $1
        AND ev.used_at IS NULL
        AND ev.expires_at > now()
      LIMIT 1`,
    [hashVerificationToken(token)],
  );
  return rows.rows[0] ?? null;
}

/**
 * Mark a verification token as used so it can't be redeemed twice. Run inside
 * the same transaction that stamps `users.email_verified_at` so a partial
 * commit can't leave the token unspent against a verified account.
 */
export async function markEmailVerificationUsed(
  verificationId: string,
  client: pg.PoolClient,
): Promise<void> {
  // Conditional on `used_at IS NULL` so two concurrent requests carrying the
  // same token can't both redeem it (findValidEmailVerificationToken runs
  // outside this transaction, so its check is racy). The loser updates 0 rows
  // and throws, rolling back — only one request can consume the token.
  const res = await client.query(
    "UPDATE email_verifications SET used_at = now() WHERE id = $1 AND used_at IS NULL",
    [verificationId],
  );
  if (res.rowCount === 0) {
    throw new Error("verification_token_already_used");
  }
}
