import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTotpUri,
  decryptAdminMfaSecret,
  encryptAdminMfaSecret,
  generateTotpSecret,
  isPendingAdminMfaEnrollmentOwned,
  totpCodeAt,
  verifyTotpCode,
} from "../lib/admin-mfa";
import { hasFreshAdminMfa } from "../lib/admin-auth";
import type { AuthenticatedUser } from "../lib/session";

// Public RFC 6238 test vector, split so secret scanners do not mistake the
// deterministic fixture for an operator credential.
const RFC_SECRET = ["GEZDGNBV", "GY3TQOJQ", "GEZDGNBV", "GY3TQOJQ"].join("");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("administrator TOTP", () => {
  it("matches the RFC 6238 SHA-1 vectors at six digits", () => {
    expect(totpCodeAt(RFC_SECRET, 59_000)).toBe("287082");
    expect(totpCodeAt(RFC_SECRET, 1_111_111_109_000)).toBe("081804");
    expect(totpCodeAt(RFC_SECRET, 1_234_567_890_000)).toBe("005924");
  });

  it("accepts only the bounded clock window and returns the replay counter", () => {
    const at = 1_234_567_890_000;
    const code = totpCodeAt(RFC_SECRET, at);
    expect(verifyTotpCode(RFC_SECRET, code, at)).toBe(Math.floor(at / 1000 / 30));
    expect(verifyTotpCode(RFC_SECRET, code, at + 31_000, 0)).toBeNull();
    expect(verifyTotpCode(RFC_SECRET, "12345x", at)).toBeNull();
  });

  it("generates an authenticator-compatible setup URI", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    const uri = new URL(buildTotpUri(secret, "admin@example.com"));
    expect(uri.protocol).toBe("otpauth:");
    expect(uri.searchParams.get("secret")).toBe(secret);
    expect(uri.searchParams.get("issuer")).toBe("Axel");
    expect(uri.searchParams.get("digits")).toBe("6");
  });

  it("binds the encrypted secret to the administrator identity", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "11".repeat(32));
    const sealed = await encryptAdminMfaSecret(RFC_SECRET, "usr_admin");
    await expect(decryptAdminMfaSecret(sealed, "usr_admin")).resolves.toBe(RFC_SECRET);
    await expect(decryptAdminMfaSecret(sealed, "usr_other")).rejects.toThrow();
  });

  it("exposes pending enrollment only to the password-confirmed session before expiry", () => {
    const now = Date.parse("2026-08-27T12:00:00.000Z");
    const pending = {
      secretCiphertext: Buffer.from("sealed"),
      enabledAt: null,
      lastUsedCounter: null,
      enrollmentSessionTokenHash: "session-a",
      enrollmentExpiresAt: "2026-08-27T12:10:00.000Z",
    };
    expect(isPendingAdminMfaEnrollmentOwned(pending, "session-a", now)).toBe(true);
    expect(isPendingAdminMfaEnrollmentOwned(pending, "session-b", now)).toBe(false);
    expect(isPendingAdminMfaEnrollmentOwned(pending, "session-a", Date.parse(pending.enrollmentExpiresAt))).toBe(false);
    expect(isPendingAdminMfaEnrollmentOwned({ ...pending, enabledAt: "2026-08-27T12:01:00.000Z" }, "session-a", now)).toBe(false);
  });
});

describe("administrator step-up freshness", () => {
  const auth = (verifiedAt: string | null, enabledAt: string | null = "2026-08-27T00:00:00.000Z") => ({
    user: {
      id: "usr_admin",
      email: "admin@example.com",
      name: "Admin",
      isSuperAdmin: true,
      emailVerifiedAt: "2026-08-01T00:00:00.000Z",
    },
    impersonator: null,
    adminMfaEnabledAt: enabledAt,
    adminMfaVerifiedAt: verifiedAt,
  }) satisfies AuthenticatedUser;

  it("requires enrollment and a verification within fifteen minutes", () => {
    const now = Date.parse("2026-08-27T12:15:00.000Z");
    expect(hasFreshAdminMfa(auth("2026-08-27T12:05:01.000Z"), now)).toBe(true);
    expect(hasFreshAdminMfa(auth("2026-08-27T12:00:00.000Z"), now)).toBe(false);
    expect(hasFreshAdminMfa(auth(null), now)).toBe(false);
    expect(hasFreshAdminMfa(auth("2026-08-27T12:10:00.000Z", null), now)).toBe(false);
    expect(hasFreshAdminMfa(auth("2026-08-27T12:16:00.000Z"), now)).toBe(false);
  });
});
