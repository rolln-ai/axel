import { describe, expect, it } from "vitest";
import { redactFixturePayload } from "../lib/data-contracts/fixture-redaction";

describe("redactFixturePayload", () => {
  it("redacts path-sensitive leaves (type-preserving) and masks values elsewhere", () => {
    const out = redactFixturePayload({
      customer: { email: "alice@example.com", name: "Alice" },
      card_number: "4111111111111111",
      account_balance: 12,
      note: "reach me at bob@x.com or 4111 1111 1111 1111",
      status: "active",
    });
    expect(out).toEqual({
      customer: { email: "[REDACTED]", name: "Alice" },
      card_number: "[REDACTED]",
      account_balance: 12,
      note: "reach me at [EMAIL] or [NUM]",
      status: "active",
    });
  });

  it("recurses into arrays and preserves the number type for sensitive numeric fields", () => {
    expect(redactFixturePayload({ items: [{ ssn: 123456789 }, { ssn: "123-45-6789" }] })).toEqual({
      items: [{ ssn: 0 }, { ssn: "[REDACTED]" }],
    });
  });

  it("is idempotent (re-redacting masked data is a no-op)", () => {
    const once = redactFixturePayload({ email: "a@b.com", note: "acct 4111111111111111" });
    expect(redactFixturePayload(once)).toEqual(once);
  });

  it("leaves PII-free payloads untouched", () => {
    const payload = { type: "a", id: 1, nested: { count: 3, ok: true } };
    expect(redactFixturePayload(payload)).toEqual(payload);
  });
});
