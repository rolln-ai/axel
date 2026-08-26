import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("authenticated dashboard layout privacy", () => {
  it("does not load third-party analytics scripts into webhook-data pages", () => {
    const source = readFileSync(new URL("../app/layout.tsx", import.meta.url), "utf8");

    expect(source).not.toMatch(/cloud\.umami\.is/i);
    expect(source).not.toMatch(/googletagmanager\.com|\bgtag\b|\bdataLayer\b/i);
    expect(source).not.toMatch(/<script\b/i);
    expect(source).not.toContain("dangerouslySetInnerHTML");
    expect(source).not.toContain("SignupConversionTracker");
  });
});
