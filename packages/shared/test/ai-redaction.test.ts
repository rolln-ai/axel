import { describe, expect, it } from "vitest";
import {
  isSecretLikeWebhookKey,
  redactAiPrompt,
  redactSecretLikeText,
  redactWebhookDataForAi,
  safeWebhookSchemaKey,
  summarizeWebhookDataForAi,
  summarizeWebhookFieldPathForAi,
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
  it("replaces every primitive webhook value while retaining safe field names and shape", () => {
    const input = {
      type: "invoice.paid",
      status: "complete",
      amount: 1299,
      active: true,
      optional: null,
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
      items: [{ sku: "private-sku", quantity: 2 }],
    };
    const redacted = redactWebhookDataForAi(input);

    const serialized = JSON.stringify(redacted);
    for (const secret of [
      "invoice.paid",
      "complete",
      "1299",
      "true",
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
      "private-sku",
    ]) {
      expect(serialized).not.toContain(secret);
    }

    expect(redacted).toEqual({
      type: "[string]",
      status: "[string]",
      amount: "[number]",
      active: "[boolean]",
      optional: "[null]",
      password: "[string]",
      headers: {
        Authorization: "[string]",
        Cookie: "[string]",
        "X-Hub-Signature-256": "[string]",
        "X-Custom-Header": "[string]",
      },
      callback: "[string]",
      note: "[string]",
      card_number_as_number: "[number]",
      items: [{ sku: "[string]", quantity: "[number]" }],
    });
    expect(summarizeWebhookDataForAi(input)).toEqual(redacted);
    expect(JSON.parse(redactAiPrompt(JSON.stringify(redacted)))).toEqual(redacted);
  });

  it("placeholders dynamic and PII-like object keys but keeps static schema paths", () => {
    const summarized = summarizeWebhookDataForAi({
      customer: { email_address: "private@example.test" },
      "private@example.test": { amount: 42 },
      "550e8400-e29b-41d4-a716-446655440000": "private",
      "203.0.113.8": false,
      "0123456789abcdef0123456789abcdef": "secret",
      constructor: { prototype: "private" },
    });

    expect(summarized).toEqual({
      customer: { email_address: "[string]" },
      "[dynamic_key_1]": { amount: "[number]" },
      "[dynamic_key_2]": "[string]",
      "[dynamic_key_3]": "[boolean]",
      "[dynamic_key_4]": "[string]",
      "[dynamic_key_5]": { "[dynamic_key_1]": "[string]" },
    });
    expect(safeWebhookSchemaKey("customer_id")).toBe(true);
    expect(safeWebhookSchemaKey("private@example.test")).toBe(false);
    expect(safeWebhookSchemaKey("__proto__")).toBe(false);
    expect(summarizeWebhookFieldPathForAi("data.items[].customer_id")).toBe(
      "data.items[].customer_id",
    );
    expect(
      summarizeWebhookFieldPathForAi(
        "accounts.550e8400-e29b-41d4-a716-446655440000.balance",
      ),
    ).toBe("accounts.[dynamic_key].balance");
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
