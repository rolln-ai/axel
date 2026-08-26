import { afterEach, describe, expect, it, vi } from "vitest";
import { sendEmail } from "../lib/email";

describe("production email fallback safety", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails without logging the recipient or one-shot link when Resend is absent", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recipient = "person@example.test";
    const oneShotLink = "https://axel.example.test/reset?token=super-secret";

    await expect(
      sendEmail({
        to: recipient,
        subject: "Reset your password",
        html: `<a href="${oneShotLink}">Reset</a>`,
        text: oneShotLink,
      }),
    ).resolves.toEqual({
      ok: false,
      error: "Email delivery is not configured.",
    });

    expect(log).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[email] delivery is not configured; message was not sent",
    );
    const serializedWarnings = JSON.stringify(warn.mock.calls);
    expect(serializedWarnings).not.toContain(recipient);
    expect(serializedWarnings).not.toContain("super-secret");
  });
});
