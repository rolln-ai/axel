import { describe, expect, it } from "vitest";
import { resolveDashboardSentryDsn } from "../lib/sentry-runtime-config";

describe("dashboard Sentry runtime config", () => {
  it("prefers the server DSN in production when both spellings are configured", () => {
    expect(
      resolveDashboardSentryDsn({
        SENTRY_DSN: "https://server@example.sentry.io/1",
        NEXT_PUBLIC_SENTRY_DSN: "https://public@example.sentry.io/1",
      }),
    ).toBe("https://server@example.sentry.io/1");
  });

  it("uses the public DSN for preview server and edge runtimes", () => {
    expect(
      resolveDashboardSentryDsn({
        NEXT_PUBLIC_SENTRY_DSN: "https://public@example.sentry.io/1",
      }),
    ).toBe("https://public@example.sentry.io/1");
  });

  it("keeps the SDK disabled when no DSN is configured", () => {
    expect(resolveDashboardSentryDsn({})).toBeUndefined();
  });
});
