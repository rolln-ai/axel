import { describe, expect, it } from "vitest";
import {
  sanitizeConnectorDiagnosticForStorage,
  sanitizeConnectorResponseForStorage,
} from "../src/pii-mask.js";

describe("sanitizeConnectorResponseForStorage", () => {
  it("drops response bodies and redacts nested secret fields", () => {
    expect(sanitizeConnectorResponseForStorage({
      status: 400,
      body: '{"password":"webhook-secret","email":"alice@example.test"}',
      nested: {
        response_body: "raw webhook bytes",
        access_token: "sk_live_should_not_leave",
      },
    })).toEqual({
      status: 400,
      nested: { access_token: "[REDACTED]" },
    });
  });

  it("redacts quoted values, credentials, URL queries, email, and long numbers", () => {
    const result = sanitizeConnectorResponseForStorage({
      error:
        'insert failed for "alice@example.test" with Bearer abcdefgh and card 4111111111111111 at https://example.test/x?token=secret',
    }) as { error: string };

    expect(result.error).not.toContain("alice@example.test");
    expect(result.error).not.toContain("abcdefgh");
    expect(result.error).not.toContain("4111111111111111");
    expect(result.error).not.toContain("token=secret");
    expect(result.error).toContain("[REDACTED]");
  });
});

describe("sanitizeConnectorDiagnosticForStorage", () => {
  it("redacts payload echoes and arbitrary labeled secrets", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      'insert failed: payload={"email":"victim@example.test", "note":"private webhook text"}; password=hunter2; api_key: opaque-value',
    );

    expect(result).not.toContain("victim@example.test");
    expect(result).not.toContain("private webhook text");
    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("opaque-value");
    expect(result).toContain("payload=[REDACTED]");
  });

  it("redacts URL userinfo and query credentials before logging", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      "connect postgres://alice:db-password@db.example.test/main?sslkey=private-key",
    );

    expect(result).not.toContain("db-password");
    expect(result).not.toContain("private-key");
    expect(result).toContain("postgres://alice:[REDACTED]@db.example.test/main?sslkey=[REDACTED]");
  });

  it("honors the caller's storage limit", () => {
    expect(sanitizeConnectorDiagnosticForStorage("x".repeat(100), 32)).toHaveLength(32);
  });

  it("drops an unterminated private-key block", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      "signing failed -----BEGIN PRIVATE KEY-----\nopaque-private-material",
    );

    expect(result).not.toContain("opaque-private-material");
    expect(result).toContain("[REDACTED PRIVATE KEY]");
  });

  it("keeps HTTP status diagnostics but drops an unlabeled receiver echo", () => {
    expect(sanitizeConnectorDiagnosticForStorage("HTTP 400: hunter2")).toBe(
      "HTTP 400: [REDACTED]",
    );
    expect(
      sanitizeConnectorDiagnosticForStorage(
        "destination_http_502: private webhook text\nsecond line",
      ),
    ).toBe("destination_http_502: [REDACTED]");
  });
});
