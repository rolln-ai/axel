import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../lib/db", () => ({
  db: () => ({ query }),
}));

const sendEmail = vi.fn();
vi.mock("../lib/email", () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const issueEmailVerificationToken = vi.fn();
vi.mock("../lib/email-verification", () => ({
  issueEmailVerificationToken: (...args: unknown[]) => issueEmailVerificationToken(...args),
}));

const enforceAuthRateLimits = vi.fn();
vi.mock("../lib/rate-limit", () => ({
  enforceAuthRateLimits: (...args: unknown[]) => enforceAuthRateLimits(...args),
  rateLimitMessage: () => "Too many attempts.",
}));

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.10" }),
}));

describe("resendVerificationEmailForUser", () => {
  beforeEach(() => {
    query.mockReset();
    sendEmail.mockReset();
    issueEmailVerificationToken.mockReset();
    enforceAuthRateLimits.mockReset();
    enforceAuthRateLimits.mockResolvedValue(null);
    issueEmailVerificationToken.mockResolvedValue({
      token: "verification-token",
      expiresAt: new Date("2026-08-25T00:00:00.000Z"),
    });
  });

  it("reports success only after the email provider accepts the send", async () => {
    query.mockResolvedValue({
      rows: [{ email: "person@example.com", email_verified_at: null }],
    });
    sendEmail.mockResolvedValue({ ok: true, messageId: "email_123" });

    const { resendVerificationEmailForUser } = await import("../lib/email-verification-resend");
    const result = await resendVerificationEmailForUser("usr_123");

    expect(result).toEqual({
      notice: "Verification email sent to person@example.com. The link expires in 24 hours.",
    });
    expect(issueEmailVerificationToken).toHaveBeenCalledWith("usr_123", "203.0.113.10");
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "person@example.com",
        subject: "Verify your email for Axel",
        text: expect.stringContaining("verification-token"),
      }),
    );
  });

  it("surfaces a provider rejection instead of reporting false success", async () => {
    query.mockResolvedValue({
      rows: [{ email: "person@example.com", email_verified_at: null }],
    });
    sendEmail.mockResolvedValue({ ok: false, error: "provider rejected request" });

    const { resendVerificationEmailForUser } = await import("../lib/email-verification-resend");
    const result = await resendVerificationEmailForUser("usr_123");

    expect(result).toEqual({ error: "Could not send the verification email. Try again." });
    expect(result.notice).toBeUndefined();
  });

  it("does not send another email after the address is verified", async () => {
    query.mockResolvedValue({
      rows: [{ email: "person@example.com", email_verified_at: "2026-08-24T18:00:00.000Z" }],
    });

    const { resendVerificationEmailForUser } = await import("../lib/email-verification-resend");
    const result = await resendVerificationEmailForUser("usr_123");

    expect(result).toEqual({ notice: "Your email is already verified." });
    expect(issueEmailVerificationToken).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
