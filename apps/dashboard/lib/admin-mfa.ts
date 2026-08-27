import "server-only";

import {
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  decryptPackedCredential,
  deriveFlexibleMasterKey,
  encryptPackedCredential,
} from "@axel/shared";
import { db } from "./db";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const TOTP_SECRET_BYTES = 20;

export const ADMIN_MFA_FRESH_MINUTES = 15;
export const ADMIN_MFA_ENROLLMENT_MINUTES = 10;

export interface AdminMfaMethod {
  secretCiphertext: Buffer;
  enabledAt: string | null;
  lastUsedCounter: number | null;
  enrollmentSessionTokenHash: string | null;
  enrollmentExpiresAt: string | null;
}

export function isPendingAdminMfaEnrollmentOwned(
  method: AdminMfaMethod | null,
  sessionTokenHash: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (
    !method
    || method.enabledAt
    || !sessionTokenHash
    || method.enrollmentSessionTokenHash !== sessionTokenHash
    || !method.enrollmentExpiresAt
  ) {
    return false;
  }
  const expiresAt = Date.parse(method.enrollmentExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > nowMs;
}

function masterKey(): Promise<Uint8Array> {
  const raw = process.env.CREDENTIALS_MASTER_KEY;
  if (!raw) {
    throw new Error("CREDENTIALS_MASTER_KEY is required for administrator MFA");
  }
  return deriveFlexibleMasterKey(raw);
}

function aad(userId: string): string {
  return `axel:admin-mfa:v1:${userId}`;
}

export async function encryptAdminMfaSecret(secret: string, userId: string): Promise<Buffer> {
  const ciphertext = await encryptPackedCredential(secret, await masterKey(), aad(userId));
  return Buffer.from(ciphertext);
}

export async function decryptAdminMfaSecret(ciphertext: Buffer, userId: string): Promise<string> {
  return decryptPackedCredential(ciphertext, await masterKey(), aad(userId));
}

export async function getAdminMfaMethod(userId: string): Promise<AdminMfaMethod | null> {
  const result = await db().query<{
    secret_ciphertext: Buffer;
    enabled_at: string | null;
    last_used_counter: string | null;
    enrollment_session_token_hash: string | null;
    enrollment_expires_at: string | null;
  }>(
    `SELECT secret_ciphertext,
            enabled_at::text AS enabled_at,
            last_used_counter::text AS last_used_counter,
            enrollment_session_token_hash,
            enrollment_expires_at::text AS enrollment_expires_at
       FROM admin_mfa_methods
      WHERE user_id = $1
      LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    secretCiphertext: row.secret_ciphertext,
    enabledAt: row.enabled_at,
    lastUsedCounter: row.last_used_counter === null ? null : Number(row.last_used_counter),
    enrollmentSessionTokenHash: row.enrollment_session_token_hash,
    enrollmentExpiresAt: row.enrollment_expires_at,
  };
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(TOTP_SECRET_BYTES));
}

export function buildTotpUri(secret: string, email: string): string {
  const issuer = "Axel";
  const label = `${issuer}:${email}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function totpCodeAt(secret: string, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  return totpCodeForCounter(secret, counter);
}

/**
 * Verify one authenticator code and return its time-step counter. Callers
 * persist the counter and reject reuse, which closes the normal 30-second
 * TOTP replay window across concurrent administrator sessions.
 */
export function verifyTotpCode(
  secret: string,
  candidate: string,
  atMs: number = Date.now(),
  window = 1,
): number | null {
  const normalized = candidate.replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = current + delta;
    if (counter < 0) continue;
    const expected = Buffer.from(totpCodeForCounter(secret, counter), "ascii");
    const provided = Buffer.from(normalized, "ascii");
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      return counter;
    }
  }
  return null;
}

function totpCodeForCounter(secret: string, counter: number): string {
  const key = decodeBase32(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value =
    (((digest[offset]! & 0x7f) << 24)
      | (digest[offset + 1]! << 16)
      | (digest[offset + 2]! << 8)
      | digest[offset + 3]!) % 10 ** TOTP_DIGITS;
  return String(value).padStart(TOTP_DIGITS, "0");
}

function encodeBase32(input: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function decodeBase32(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || [...normalized].some((char) => !BASE32_ALPHABET.includes(char))) {
    throw new Error("invalid TOTP secret");
  }
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of normalized) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
