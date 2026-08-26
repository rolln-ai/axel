import { describe, expect, it } from "vitest";
import { loginPathWithReturnTo, safeReturnTo } from "../lib/return-to";

describe("safeReturnTo", () => {
  it("accepts same-origin relative paths, preserving the query string", () => {
    expect(safeReturnTo("/routes/abc?x=1")).toBe("/routes/abc?x=1");
    expect(safeReturnTo("/sources")).toBe("/sources");
    expect(safeReturnTo("/deliveries/del_1?tab=attempts&page=2")).toBe(
      "/deliveries/del_1?tab=attempts&page=2",
    );
    expect(safeReturnTo("/dashboard")).toBe("/dashboard");
  });

  it("rejects protocol-relative URLs", () => {
    expect(safeReturnTo("//evil.com")).toBeNull();
    expect(safeReturnTo("//evil.com/routes")).toBeNull();
  });

  it("rejects absolute URLs and schemes", () => {
    expect(safeReturnTo("https://evil.com")).toBeNull();
    expect(safeReturnTo("http://evil.com/")).toBeNull();
    expect(safeReturnTo("javascript:alert(1)")).toBeNull();
  });

  it("rejects backslash variants browsers normalize to slashes", () => {
    expect(safeReturnTo("/\\evil")).toBeNull();
    expect(safeReturnTo("/\\evil.com")).toBeNull();
    expect(safeReturnTo("/routes\\..\\evil")).toBeNull();
  });

  it("rejects non-paths, empties, and oversized values", () => {
    expect(safeReturnTo(null)).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
    expect(safeReturnTo("")).toBeNull();
    expect(safeReturnTo("routes/abc")).toBeNull();
    expect(safeReturnTo(`/${"a".repeat(2100)}`)).toBeNull();
  });

  it("rejects whitespace and control characters", () => {
    expect(safeReturnTo("/routes\r\nSet-Cookie: x=1")).toBeNull();
    expect(safeReturnTo("/routes abc")).toBeNull();
    expect(safeReturnTo("/routes\u0000")).toBeNull();
  });

  it("rejects auth pages and the bare root as round-trip targets", () => {
    expect(safeReturnTo("/")).toBeNull();
    expect(safeReturnTo("/login")).toBeNull();
    expect(safeReturnTo("/login?returnTo=/routes")).toBeNull();
    expect(safeReturnTo("/signup")).toBeNull();
    expect(safeReturnTo("/reset?token=abc")).toBeNull();
    expect(safeReturnTo("/verify/anything")).toBeNull();
    // ...but only as path PREFIX segments, not substrings.
    expect(safeReturnTo("/loginaudit")).toBe("/loginaudit");
  });
});

describe("loginPathWithReturnTo", () => {
  it("encodes a valid origin path into the login URL", () => {
    expect(loginPathWithReturnTo("/routes/abc?x=1")).toBe(
      `/login?returnTo=${encodeURIComponent("/routes/abc?x=1")}`,
    );
  });

  it("falls back to bare /login for invalid or absent values", () => {
    expect(loginPathWithReturnTo(null)).toBe("/login");
    expect(loginPathWithReturnTo("//evil.com")).toBe("/login");
    expect(loginPathWithReturnTo("https://evil.com")).toBe("/login");
  });
});
