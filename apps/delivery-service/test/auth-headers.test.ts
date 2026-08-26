import { describe, expect, it } from "vitest";
import { buildHttpAuthConfig, isSafeHeaderName, isSafeHeaderValue } from "../src/auth-headers.ts";

describe("buildHttpAuthConfig (AXE-33 + Sev1 audit)", () => {
  it("is idempotent when auth_type is 'none'", () => {
    const config = { url: "https://example.test/hook", auth_type: "none", headers: { "X-Foo": "bar" } };
    expect(buildHttpAuthConfig(config)).toEqual(config);
  });

  it("is idempotent when auth_type is missing", () => {
    const config = { url: "https://example.test/hook" };
    expect(buildHttpAuthConfig(config)).toEqual(config);
  });

  it("builds an Authorization: Bearer header for the bearer mode", () => {
    const out = buildHttpAuthConfig({
      auth_type: "bearer",
      bearer_token: "tok-123",
    });
    expect(out.headers).toEqual({ Authorization: "Bearer tok-123" });
  });

  it("builds an Authorization: Basic header (base64) for the basic mode", () => {
    const out = buildHttpAuthConfig({
      auth_type: "basic",
      basic_user: "alice",
      basic_password: "s3cret",
    });
    expect(out.headers).toEqual({
      Authorization: `Basic ${Buffer.from("alice:s3cret").toString("base64")}`,
    });
  });

  it("sets the named header verbatim (no Bearer prefix) for api_key mode", () => {
    const out = buildHttpAuthConfig({
      auth_type: "api_key",
      api_key_header: "X-API-Key",
      api_key_value: "kv-456",
    });
    expect(out.headers).toEqual({ "X-API-Key": "kv-456" });
  });

  it("parses multi-line custom_headers and strips # comments + blank lines", () => {
    const out = buildHttpAuthConfig({
      auth_type: "custom_headers",
      custom_headers: "# leading comment\nX-Sig: abc\n\nX-Time: 123",
    });
    expect(out.headers).toEqual({ "X-Sig": "abc", "X-Time": "123" });
  });

  it("preserves pre-existing headers when adding auth headers", () => {
    const out = buildHttpAuthConfig({
      auth_type: "bearer",
      bearer_token: "tok",
      headers: { "X-Static": "keep" },
    });
    expect(out.headers).toEqual({ "X-Static": "keep", Authorization: "Bearer tok" });
  });

  it("ignores empty bearer_token rather than sending an empty Authorization", () => {
    const out = buildHttpAuthConfig({ auth_type: "bearer", bearer_token: "" });
    expect(out.headers).toEqual({});
  });

  describe("Sev1 security: header injection blocks", () => {
    it("drops a custom_headers attempt to set Host (directed SSRF)", () => {
      const out = buildHttpAuthConfig({
        auth_type: "custom_headers",
        custom_headers: "Host: internal.svc\nX-Real: ok",
      });
      expect(out.headers).toEqual({ "X-Real": "ok" });
    });

    it("drops Content-Length / Transfer-Encoding (request smuggling)", () => {
      const out = buildHttpAuthConfig({
        auth_type: "custom_headers",
        custom_headers: "Content-Length: 0\nTransfer-Encoding: chunked\nX-Ok: yes",
      });
      expect(out.headers).toEqual({ "X-Ok": "yes" });
    });

    it("drops Connection / Proxy-* / Upgrade hop-by-hop names", () => {
      const out = buildHttpAuthConfig({
        auth_type: "custom_headers",
        custom_headers: "Connection: close\nUpgrade: h2c\nProxy-Authorization: foo\nX-Ok: yes",
      });
      expect(out.headers).toEqual({ "X-Ok": "yes" });
    });

    it("drops header values containing CR/LF (smuggling)", () => {
      const crlfPayload = "abc\r\nX-Injected: yes";
      const out = buildHttpAuthConfig({
        auth_type: "api_key",
        api_key_header: "X-Sig",
        api_key_value: crlfPayload,
      });
      expect(out.headers).toEqual({});
    });

    it("drops header names that don't match RFC 7230 token grammar", () => {
      const out = buildHttpAuthConfig({
        auth_type: "api_key",
        api_key_header: "X Header With Spaces",
        api_key_value: "v",
      });
      expect(out.headers).toEqual({});
    });

    it("is case-insensitive for the FORBIDDEN_HEADER_NAMES check", () => {
      const out = buildHttpAuthConfig({
        auth_type: "custom_headers",
        custom_headers: "HOST: bad\nhost: also-bad\nHoSt: still-bad\nX-Ok: yes",
      });
      expect(out.headers).toEqual({ "X-Ok": "yes" });
    });

    it("drops NUL byte in header values", () => {
      const out = buildHttpAuthConfig({
        auth_type: "api_key",
        api_key_header: "X-Sig",
        api_key_value: "before\0after",
      });
      expect(out.headers).toEqual({});
    });
  });
});

describe("isSafeHeaderName", () => {
  it("accepts ordinary RFC 7230 token-shaped names", () => {
    for (const n of ["X-API-Key", "Authorization", "Content-Type", "X_Underscore"]) {
      expect(isSafeHeaderName(n)).toBe(true);
    }
  });

  it("rejects empty + non-token characters", () => {
    for (const n of ["", "X Header", "X\nFoo", "X:Foo", "X(bar)"]) {
      expect(isSafeHeaderName(n)).toBe(false);
    }
  });

  it("rejects forbidden hop-by-hop names regardless of casing", () => {
    for (const n of ["Host", "host", "HOST", "Content-Length", "transfer-encoding"]) {
      expect(isSafeHeaderName(n)).toBe(false);
    }
  });
});

describe("isSafeHeaderValue", () => {
  it("accepts plain values", () => {
    expect(isSafeHeaderValue("Bearer abc123")).toBe(true);
    expect(isSafeHeaderValue("")).toBe(true);
  });

  it("rejects CR/LF/NUL", () => {
    expect(isSafeHeaderValue("a\rb")).toBe(false);
    expect(isSafeHeaderValue("a\nb")).toBe(false);
    expect(isSafeHeaderValue("a\r\nb")).toBe(false);
    expect(isSafeHeaderValue("a\0b")).toBe(false);
  });
});
