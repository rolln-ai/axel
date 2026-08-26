import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
}));

vi.mock("posthog-js", () => ({ default: posthog }));

describe("PostHog privacy configuration", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  it("cannot capture DOM text, attributes, or session recordings", async () => {
    const { enableAnalytics } = await import("../lib/consent");

    enableAnalytics();

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        autocapture: false,
        disable_session_recording: true,
        mask_all_text: true,
        mask_all_element_attributes: true,
        capture_pageview: false,
        capture_pageleave: false,
        opt_out_capturing_by_default: true,
      }),
    );
    expect(posthog.opt_in_capturing).toHaveBeenCalledOnce();
  });

  it.each([
    ["password reset", "https://app.axel.invalid/reset?token=reset-secret"],
    ["email verification", "https://app.axel.invalid/verify?token=verify-secret"],
    ["workspace invite", "https://app.axel.invalid/signup?invite=invite-secret"],
  ])("never initializes on a %s URL", async (_name, href) => {
    vi.stubGlobal("window", { location: new URL(href) });
    const { enableAnalytics } = await import("../lib/consent");

    enableAnalytics();

    expect(posthog.init).not.toHaveBeenCalled();
    expect(posthog.opt_in_capturing).not.toHaveBeenCalled();
  });

  it("sanitizes capture properties and disables flags and remote code", async () => {
    const { enableAnalytics } = await import("../lib/consent");
    enableAnalytics();

    const config = posthog.init.mock.calls[0]?.[1] as {
      advanced_disable_feature_flags: boolean;
      advanced_disable_flags: boolean;
      before_send: (capture: {
        event: string;
        properties: Record<string, unknown>;
        uuid: string;
      }) => unknown;
      custom_personal_data_properties: string[];
      disable_conversations: boolean;
      disable_external_dependency_loading: boolean;
      disable_product_tours: boolean;
      disable_surveys: boolean;
      mask_personal_data_properties: boolean;
    };

    expect(config).toMatchObject({
      advanced_disable_feature_flags: true,
      advanced_disable_flags: true,
      disable_conversations: true,
      disable_external_dependency_loading: true,
      disable_product_tours: true,
      disable_surveys: true,
      mask_personal_data_properties: true,
    });
    expect(config.custom_personal_data_properties).toEqual(
      expect.arrayContaining(["token", "invite", "access_token", "client_secret"]),
    );

    const capture = config.before_send({
      event: "dashboard action",
      properties: {
        $current_url: "https://app.axel.invalid/reset?token=reset-secret",
        $referrer: "https://app.axel.invalid/verify?token=verify-secret",
        next_url: "https://app.axel.invalid/signup?invite=invite-secret",
        nested: { access_token: "api-secret" },
      },
      uuid: "event-1",
    });
    const serialized = JSON.stringify(capture);

    for (const secret of [
      "reset-secret",
      "verify-secret",
      "invite-secret",
      "api-secret",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });
});
