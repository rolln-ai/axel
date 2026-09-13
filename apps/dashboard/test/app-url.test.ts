import { afterEach, describe, expect, it, vi } from "vitest";
import { appBaseUrl } from "../lib/app-url";

afterEach(() => vi.unstubAllEnvs());

describe("dashboard origins", () => {
  it("uses the self-host runtime origin for links even with a different build origin", () => {
    vi.stubEnv("AXEL_APP_URL", "https://selfhost.example.test/");
    vi.stubEnv("NEXT_PUBLIC_AXEL_APP_URL", "https://build.example.test");
    expect(appBaseUrl()).toBe("https://selfhost.example.test");
  });

  it("keeps the configured cloud origin when no runtime override is set", () => {
    vi.stubEnv("AXEL_APP_URL", undefined);
    vi.stubEnv("NEXT_PUBLIC_AXEL_APP_URL", "https://cloud.example.test/");
    expect(appBaseUrl()).toBe("https://cloud.example.test");
  });
});
