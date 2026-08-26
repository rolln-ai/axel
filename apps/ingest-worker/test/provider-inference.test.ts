import { describe, expect, it } from "vitest";
import { inferProvider, parsePastedSample } from "@axel/shared";

describe("inferProvider", () => {
  it("matches Stripe via Stripe-Signature header (highest confidence)", () => {
    const result = inferProvider({
      payload: { id: "evt_1", type: "charge.succeeded" },
      headers: { "Stripe-Signature": "t=0,v1=abc" },
    });
    expect(result.provider).toBe("stripe");
    expect(result.event_type).toBe("charge.succeeded");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("falls back to payload-shape detection for Stripe when headers are absent", () => {
    const result = inferProvider({
      payload: { id: "evt_test", object: "event", type: "invoice.paid" },
    });
    expect(result.provider).toBe("stripe");
    expect(result.event_type).toBe("invoice.paid");
    expect(result.confidence).toBeGreaterThanOrEqual(0.8);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("matches GitHub via X-GitHub-Event header", () => {
    const result = inferProvider({
      payload: { ref: "refs/heads/main" },
      headers: { "X-GitHub-Event": "push" },
    });
    expect(result.provider).toBe("github");
    expect(result.event_type).toBe("push");
  });

  it("matches Shopify via X-Shopify-Topic header", () => {
    const result = inferProvider({
      payload: { id: 123 },
      headers: { "X-Shopify-Topic": "orders/create" },
    });
    expect(result.provider).toBe("shopify");
    expect(result.event_type).toBe("orders/create");
  });

  it("matches Chargebee via snake_case event_type + content envelope", () => {
    const result = inferProvider({
      payload: {
        event_type: "subscription_created",
        content: { subscription: { id: "sub_123" } },
      },
    });
    expect(result.provider).toBe("chargebee");
    expect(result.event_type).toBe("subscription_created");
  });

  it("falls back to custom for unrecognised payloads", () => {
    const result = inferProvider({
      payload: { hello: "world" },
      headers: {},
    });
    expect(result.provider).toBe("custom");
    expect(result.confidence).toBe(0);
  });

  it("normalises header casing", () => {
    const result = inferProvider({
      payload: {},
      headers: { "x-shopify-hmac-sha256": "anything" },
    });
    expect(result.provider).toBe("shopify");
  });

  it("picks the highest-confidence match when multiple signals fire", () => {
    // Payload has both Stripe envelope shape AND a Shopify-ish id field.
    // Stripe header should win.
    const result = inferProvider({
      payload: { id: 1234, currency: "usd", email: "x@y.z" },
      headers: { "stripe-signature": "t=0,v1=z" },
    });
    expect(result.provider).toBe("stripe");
  });
});

describe("parsePastedSample", () => {
  it("parses a bare JSON paste", () => {
    const out = parsePastedSample('{"a":1}');
    expect(out.parse_error).toBeNull();
    expect(out.payload).toEqual({ a: 1 });
    expect(out.headers).toEqual({});
  });

  it("parses an HTTP-style paste with headers + blank line + body", () => {
    const raw = `Stripe-Signature: t=1,v1=abc\nContent-Type: application/json\n\n{"id":"evt_1"}`;
    const out = parsePastedSample(raw);
    expect(out.parse_error).toBeNull();
    expect(out.payload).toEqual({ id: "evt_1" });
    expect(out.headers["Stripe-Signature"]).toBe("t=1,v1=abc");
  });

  it("returns a clean error when paste is empty", () => {
    const out = parsePastedSample("");
    expect(out.parse_error).toContain("empty");
  });

  it("returns a clean error when JSON is malformed", () => {
    const out = parsePastedSample("{not json");
    expect(out.parse_error).toContain("JSON parse failed");
  });
});
