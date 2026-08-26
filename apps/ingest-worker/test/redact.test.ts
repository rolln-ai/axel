import { describe, expect, it } from "vitest";
import { redactJsonPayload } from "@axel/shared";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

describe("redactJsonPayload", () => {
  it("masks a top-level field", () => {
    expect(dec(redactJsonPayload(enc({ email: "a@b.com", id: 1 }), ["email"]))).toEqual({
      email: "[REDACTED]",
      id: 1,
    });
  });

  it("masks a nested field", () => {
    expect(dec(redactJsonPayload(enc({ user: { email: "x", name: "n" } }), ["user.email"]))).toEqual({
      user: { email: "[REDACTED]", name: "n" },
    });
  });

  it("masks a field on every array element", () => {
    const input = { cards: [{ cvv: "123", last4: "1111" }, { cvv: "456", last4: "2222" }] };
    expect(dec(redactJsonPayload(enc(input), ["cards[].cvv"]))).toEqual({
      cards: [{ cvv: "[REDACTED]", last4: "1111" }, { cvv: "[REDACTED]", last4: "2222" }],
    });
  });

  it("masks every element of an array", () => {
    expect(dec(redactJsonPayload(enc({ tags: ["a", "b"] }), ["tags[]"]))).toEqual({
      tags: ["[REDACTED]", "[REDACTED]"],
    });
  });

  it("applies multiple paths", () => {
    expect(dec(redactJsonPayload(enc({ email: "e", ssn: "s", keep: "k" }), ["email", "ssn"]))).toEqual({
      email: "[REDACTED]",
      ssn: "[REDACTED]",
      keep: "k",
    });
  });

  it("is a no-op for missing paths", () => {
    expect(dec(redactJsonPayload(enc({ a: 1 }), ["b.c"]))).toEqual({ a: 1 });
  });

  it("returns non-JSON bodies unchanged (same reference)", () => {
    const raw = new TextEncoder().encode("not json <xml/>");
    expect(redactJsonPayload(raw, ["a"])).toBe(raw);
  });

  it("returns the input unchanged when no paths are given", () => {
    const raw = enc({ a: 1 });
    expect(redactJsonPayload(raw, [])).toBe(raw);
  });
});
