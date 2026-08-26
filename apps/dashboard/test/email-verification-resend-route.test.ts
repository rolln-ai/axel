import { beforeEach, describe, expect, it, vi } from "vitest";

const getAuthenticatedUser = vi.fn();
vi.mock("../lib/session", () => ({
  getAuthenticatedUser: (...args: unknown[]) => getAuthenticatedUser(...args),
}));

const resendVerificationEmailForUser = vi.fn();
vi.mock("../lib/email-verification-resend", () => ({
  resendVerificationEmailForUser: (...args: unknown[]) => resendVerificationEmailForUser(...args),
}));

describe("POST /api/auth/resend-verification", () => {
  beforeEach(() => {
    getAuthenticatedUser.mockReset();
    resendVerificationEmailForUser.mockReset();
  });

  it("sends for the authenticated user through a stable JSON endpoint", async () => {
    getAuthenticatedUser.mockResolvedValue({ user: { id: "usr_123" } });
    resendVerificationEmailForUser.mockResolvedValue({ notice: "Verification email sent." });

    const { POST } = await import("../app/api/auth/resend-verification/route");
    const response = await POST(
      new Request("https://app.axelapp.ai/api/auth/resend-verification", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: "https://app.axelapp.ai",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ notice: "Verification email sent." });
    expect(resendVerificationEmailForUser).toHaveBeenCalledWith("usr_123");
  });

  it("rejects cross-origin requests", async () => {
    const { POST } = await import("../app/api/auth/resend-verification/route");
    const response = await POST(
      new Request("https://app.axelapp.ai/api/auth/resend-verification", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Origin: "https://example.com",
        },
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Invalid request." });
    expect(getAuthenticatedUser).not.toHaveBeenCalled();
    expect(resendVerificationEmailForUser).not.toHaveBeenCalled();
  });

  it("redirects a non-hydrated form back with a send result", async () => {
    getAuthenticatedUser.mockResolvedValue({ user: { id: "usr_123" } });
    resendVerificationEmailForUser.mockResolvedValue({ notice: "Verification email sent." });

    const { POST } = await import("../app/api/auth/resend-verification/route");
    const response = await POST(
      new Request("https://app.axelapp.ai/api/auth/resend-verification", {
        method: "POST",
        headers: {
          Origin: "https://app.axelapp.ai",
          Referer: "https://app.axelapp.ai/deliveries?status=dead",
        },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://app.axelapp.ai/deliveries?status=dead&verification-email=sent",
    );
  });
});
