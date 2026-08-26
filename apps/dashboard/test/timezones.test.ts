import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_TIMEZONE,
  isSupportedWorkspaceTimezone,
  normalizeWorkspaceTimezone,
  resolveWorkspaceTimezone,
  WORKSPACE_TIMEZONE_OPTIONS,
} from "../lib/timezones";

describe("resolveWorkspaceTimezone", () => {
  it("passes through zones already in the picker", () => {
    expect(resolveWorkspaceTimezone("America/Denver")).toBe("America/Denver");
    expect(resolveWorkspaceTimezone("UTC")).toBe("UTC");
  });

  it("canonicalizes aliases browsers report but the option list omits", () => {
    // Chrome reports Asia/Kolkata / Europe/Kyiv; Intl.supportedValuesOf here
    // lists the backward names. Whatever the runtime's canonical spelling is,
    // the result must be a value the Settings <select> can actually render.
    for (const zone of ["Asia/Kolkata", "Europe/Kyiv", "US/Pacific", "Asia/Saigon"]) {
      const resolved = resolveWorkspaceTimezone(zone);
      expect(resolved, zone).not.toBeNull();
      expect(isSupportedWorkspaceTimezone(resolved as string), zone).toBe(true);
    }
  });

  it("rejects junk", () => {
    expect(resolveWorkspaceTimezone("")).toBeNull();
    expect(resolveWorkspaceTimezone(null)).toBeNull();
    expect(resolveWorkspaceTimezone(undefined)).toBeNull();
    expect(resolveWorkspaceTimezone("Mars/Olympus_Mons")).toBeNull();
    expect(resolveWorkspaceTimezone("'; DROP TABLE workspaces; --")).toBeNull();
  });

  it("resolves every option the picker offers", () => {
    for (const option of WORKSPACE_TIMEZONE_OPTIONS) {
      expect(resolveWorkspaceTimezone(option.value), option.value).toBe(option.value);
    }
  });
});

describe("normalizeWorkspaceTimezone", () => {
  it("falls back to UTC for anything unresolvable", () => {
    expect(normalizeWorkspaceTimezone("nonsense")).toBe(DEFAULT_WORKSPACE_TIMEZONE);
    expect(normalizeWorkspaceTimezone(null)).toBe(DEFAULT_WORKSPACE_TIMEZONE);
  });

  it("keeps a resolvable zone", () => {
    expect(normalizeWorkspaceTimezone("Europe/London")).toBe("Europe/London");
  });
});
