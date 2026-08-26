import { describe, expect, it } from "vitest";
import { hashPassword, validatePassword, verifyPassword } from "../lib/passwords";
import { slugifyWorkspaceName } from "../lib/ids";

describe("dashboard auth primitives", () => {
  it("hashes and verifies passwords", () => {
    const hash = hashPassword("CorrectHorse9");
    expect(hash).not.toContain("CorrectHorse9");
    expect(verifyPassword("CorrectHorse9", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("enforces basic password strength", () => {
    expect(validatePassword("short")).toBe("Use at least 12 characters.");
    expect(validatePassword("alllowercasebutlong")).toBe("Use upper-case, lower-case, and numeric characters.");
    expect(validatePassword("GoodPassword9")).toBeNull();
  });

  it("normalizes workspace slugs", () => {
    expect(slugifyWorkspaceName("Axel Production Sync!")).toBe("axel-production-sync");
    expect(slugifyWorkspaceName("!!!")).toBe("workspace");
  });
});
