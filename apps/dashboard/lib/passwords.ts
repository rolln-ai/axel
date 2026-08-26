import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const ITERATIONS = 310_000;
const KEY_LENGTH = 32;
const DIGEST = "sha256";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return `pbkdf2_${DIGEST}$${ITERATIONS}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = encoded.split("$");
  if (algorithm !== `pbkdf2_${DIGEST}` || !iterationsRaw || !saltRaw || !hashRaw) {
    return false;
  }

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < 100_000) return false;

  const expected = Buffer.from(hashRaw, "base64url");
  const actual = pbkdf2Sync(password, Buffer.from(saltRaw, "base64url"), iterations, expected.length, DIGEST);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function validatePassword(password: string): string | null {
  if (password.length < 12) return "Use at least 12 characters.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    return "Use upper-case, lower-case, and numeric characters.";
  }
  return null;
}
