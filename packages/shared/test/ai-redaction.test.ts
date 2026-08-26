import { describe, expect, it } from "vitest";
import {
  isSecretLikeWebhookKey,
  redactAiPrompt,
  redactSecretLikeText,
  redactWebhookDataForAi,
} from "../src/ai-redaction";

const JWT = [
  "eyJhbGci",
  "OiJIUzI1",
  "NiJ9.",
  "eyJzdWIi",
  "OiJjdXN0",
  "b21lci0x",
  "In0.",
  "c2lnbmF0",
  "dXJlLXZh",
  "bHVl",
].join("");
const OPAQUE = ["Ab9_cdEf", "GhijKLMN", "opQRstUV", "wxYZ0123", "456789ab"].join("");
const LOWERCASE_OPAQUE = ["abcdefghijklmnop", "qrstuvwxyzabcdef"].join("");
const URI_USER = "webhook-user";
const URI_PASSWORD = "webhook-pass";

describe("AI webhook redaction", () => {
  it("removes key-identified and value-identified secrets without erasing useful shape", () => {
    const redacted = redactWebhookDataForAi({
      type: "invoice.paid",
      status: "complete",
      amount: 1299,
      password: "hunter2",
      headers: {
        Authorization: "Bearer short-auth-value",
        Cookie: "session=short-cookie",
        "X-Hub-Signature-256": "sha256=0123456789abcdef0123456789abcdef",
        "X-Custom-Header": "short-custom-header-secret",
      },
      callback:
        `https://${URI_USER}:${URI_PASSWORD}@example.test/callback?token=query-secret&mode=live`,
      note: `customer alice@example.test used ${JWT}, ${OPAQUE}, and ${LOWERCASE_OPAQUE}`,
      card_number_as_number: 4111111111111111,
    });

    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "hunter2",
      "short-auth-value",
      "short-cookie",
      "0123456789abcdef0123456789abcdef",
      "short-custom-header-secret",
      URI_USER,
      URI_PASSWORD,
      "query-secret",
      "alice@example.test",
      JWT,
      OPAQUE,
      LOWERCASE_OPAQUE,
      "4111111111111111",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(redacted).toMatchObject({
      type: "invoice.paid",
      status: "complete",
      amount: 1299,
      password: "[REDACTED]",
    });
    expect(serialized).toContain("callback");
    expect(serialized).toContain("example.test/callback");
  });

  it("sanitizes raw prompt text and preserves ordinary diagnostics", () => {
    const privateKey = `${["-----BEGIN ENCRYPTED", "PRIVATE KEY-----"].join(" ")}\nraw-private-material\n${["-----END ENCRYPTED", "PRIVATE KEY-----"].join(" ")}`;
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const raw = [
      "duplicate key violates constraint orders_pkey",
      "Authorization: Basic dXNlcjpwYXNz",
      "X-Webhook-Key: short-header-secret",
      'password="tiny-password"',
      `jwt=${JWT}`,
      `opaque=${OPAQUE}`,
      'response={"token":"tiny-token","error":"column customer_id is missing"}',
      `url=https://${"user"}:${"pass"}@example.test/path?signature=tiny-sig`,
      privateKey,
      `event_id=${uuid}`,
    ].join("\n");

    const safe = redactSecretLikeText(raw);
    expect(safe).toContain("duplicate key violates constraint orders_pkey");
    expect(safe).toContain(uuid);
    for (const secret of [
      "dXNlcjpwYXNz",
      "short-header-secret",
      "tiny-password",
      JWT,
      OPAQUE,
      "tiny-token",
      "user:pass",
      "tiny-sig",
      "raw-private-material",
    ]) {
      expect(safe).not.toContain(secret);
    }
  });

  it("recognizes authentication headers and nested secret containers", () => {
    expect(isSecretLikeWebhookKey("Authorization")).toBe(true);
    expect(isSecretLikeWebhookKey("headers.X-Hub-Signature-256")).toBe(true);
    expect(isSecretLikeWebhookKey("credentials.client.value")).toBe(true);
    expect(isSecretLikeWebhookKey("event_type")).toBe(false);
    expect(isSecretLikeWebhookKey("amount")).toBe(false);
  });

  it("keeps useful prompt context beyond the per-value string cap", () => {
    const prompt = `${"ordinary context ".repeat(400)}password=hunter2\nSAFE_TAIL`;
    const safe = redactAiPrompt(prompt);
    expect(safe).not.toContain("hunter2");
    expect(safe).toContain("SAFE_TAIL");
    expect(safe.length).toBeGreaterThan(5_000);
  });
});
