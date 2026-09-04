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
    expect(result.error).toBe("operation_failed");
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
    expect(result).toBe("operation_failed");
  });

  it("redacts URL userinfo and query credentials before logging", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      "connect postgres://alice:db-password@db.example.test/main?sslkey=private-key",
    );

    expect(result).not.toContain("db-password");
    expect(result).not.toContain("private-key");
    expect(result).toBe("operation_failed");
  });

  it("honors the caller's storage limit", () => {
    expect(sanitizeConnectorDiagnosticForStorage("x".repeat(100), 32)).toBe(
      "operation_failed",
    );
  });

  it("preserves an allowlisted replay integrity code", () => {
    expect(
      sanitizeConnectorDiagnosticForStorage("replay_payload_key_mismatch"),
    ).toBe("replay_payload_key_mismatch");
  });

  it("preserves the allowlisted Databricks response-size code", () => {
    expect(
      sanitizeConnectorDiagnosticForStorage("databricks_response_too_large"),
    ).toBe("databricks_response_too_large");
  });

  it("drops an unterminated private-key block", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      "signing failed -----BEGIN PRIVATE KEY-----\nopaque-private-material",
    );

    expect(result).not.toContain("opaque-private-material");
    expect(result).toBe("operation_failed");
  });

  it("keeps HTTP status diagnostics but drops an unlabeled receiver echo", () => {
    expect(sanitizeConnectorDiagnosticForStorage("HTTP 400: hunter2")).toBe(
      "http_error_400",
    );
    expect(
      sanitizeConnectorDiagnosticForStorage(
        "destination_http_502: private webhook text\nsecond line",
      ),
    ).toBe("http_error_502");
  });

  it.each([
    "r2_get_503: provider body",
    "queue_enqueue_500: provider body",
    "bigquery_schema_change_http_403: provider body",
    "databricks_http_429: provider body",
    "ClickHouse query failed (500): provider body",
  ])("drops provider response detail from %s", (diagnostic) => {
    const result = sanitizeConnectorDiagnosticForStorage(diagnostic);
    expect(result).not.toContain("provider body");
    expect(result).toMatch(
      /^(?:authorization_failed|http_error_500|http_error_503|rate_limited)$/,
    );
  });

  it("removes canonical raw and spill object keys from diagnostics", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      "missing queue-spill/ws-private/evt-private/dst-private/1.json and events/ws-private/provider/evt-private",
    );
    expect(result).not.toContain("ws-private");
    expect(result).not.toContain("evt-private");
    expect(result).toBe("operation_failed");
  });

  it("removes business and canary identifiers from free-text diagnostics", () => {
    const result = sanitizeConnectorDiagnosticForStorage(
      "workspace ws_private123 event 01935b3e-2c08-7c00-8000-c8a1b1e9d2f7 probe axel_canary_123456789",
    );
    expect(result).toBe("operation_failed");
  });
});
