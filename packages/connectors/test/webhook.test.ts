/**
 * Webhook connector tests — verifies the wire format and retry classification.
 *
 * The signing-shape assertions here are also what the dashboard's docs page
 * promises customers, so if any of these strings change the docs need to
 * change too.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSignedWebhookRequest,
  computeWebhookSignature,
  createWebhookConnector,
  generateWebhookSecret,
  type FetchLike,
} from "../src/index.js";
import type { Destination } from "@axel/shared";
import type { WebhookDestinationConfig } from "../src/webhook.js";

describe("webhook connector", () => {
  it("signs the request with HMAC-SHA256 over `<ts>.<body>`", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: ArrayBuffer }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 204, async text() { return ""; } };
    };

    const secret = "whsec_TEST";
    const body = new TextEncoder().encode(JSON.stringify({ ok: true }));

    const connector = createWebhookConnector(fetchImpl);
    const attempt = await connector.deliver(
      toArrayBuffer(body),
      destination("webhook", {
        url: "https://customer.test/in",
        signing_secret: secret,
        __nowSeconds: () => 1_700_000_000,
      }),
      { eventId: "evt-1" },
    );

    expect(attempt.status).toBe("success");
    const sent = calls[0]!;
    // Required headers exist with the expected values.
    expect(sent.headers["X-Axel-Timestamp"]).toBe("1700000000");
    expect(sent.headers["X-Axel-Event-Id"]).toBe("evt-1");
    expect(sent.headers["X-Axel-Webhook-Id"]).toBe("dest-1");
    // Signature is `t=<ts>,v1=<hex>` and matches a node:crypto HMAC for the
    // same timestamp + body. This is the verification path receivers will
    // run, so we want bytewise parity.
    const sigHeader = sent.headers["X-Axel-Signature"]!;
    expect(sigHeader.startsWith("t=1700000000,v1=")).toBe(true);
    const expected = createHmac("sha256", secret)
      .update(`1700000000.${new TextDecoder().decode(body)}`)
      .digest("hex");
    expect(sigHeader).toBe(`t=1700000000,v1=${expected}`);
  });

  it("supports HMAC-SHA512 when configured", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      calls.push({ headers: init.headers });
      return { status: 200, async text() { return ""; } };
    };

    const secret = "whsec_512";
    const body = new TextEncoder().encode("hello");
    const connector = createWebhookConnector(fetchImpl);
    await connector.deliver(
      toArrayBuffer(body),
      destination("webhook", {
        url: "https://customer.test/in",
        signing_secret: secret,
        signing_algorithm: "hmac-sha512",
        __nowSeconds: () => 42,
      }),
      { eventId: "evt-512" },
    );

    const sig = calls[0]!.headers["X-Axel-Signature"]!;
    const expected = createHmac("sha512", secret).update("42.hello").digest("hex");
    expect(sig).toBe(`t=42,v1=${expected}`);
  });

  it("does not allow custom headers to overwrite the signing protocol headers", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      calls.push({ headers: init.headers });
      return { status: 200, async text() { return ""; } };
    };

    const connector = createWebhookConnector(fetchImpl);
    await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("body")),
      destination("webhook", {
        url: "https://customer.test/in",
        signing_secret: "shh",
        // Try to override every protocol header. None of these should win.
        headers: {
          "X-Axel-Signature": "BOGUS",
          "X-Axel-Timestamp": "0",
          "X-Axel-Event-Id": "spoofed",
          "X-Axel-Webhook-Id": "spoofed",
        },
        __nowSeconds: () => 999,
      }),
      { eventId: "evt-real" },
    );

    const headers = calls[0]!.headers;
    expect(headers["X-Axel-Signature"]).not.toBe("BOGUS");
    expect(headers["X-Axel-Timestamp"]).toBe("999");
    expect(headers["X-Axel-Event-Id"]).toBe("evt-real");
    expect(headers["X-Axel-Webhook-Id"]).toBe("dest-1");
  });

  it("sends the request unsigned when no secret is configured (warn-only mode)", async () => {
    const calls: Array<{ headers: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      calls.push({ headers: init.headers });
      return { status: 200, async text() { return ""; } };
    };

    const connector = createWebhookConnector(fetchImpl);
    await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("hi")),
      destination("webhook", {
        url: "https://customer.test/in",
        __nowSeconds: () => 1,
        // signing_secret intentionally omitted
      }),
      { eventId: "evt-x" },
    );

    expect(calls[0]!.headers["X-Axel-Signature"]).toBeUndefined();
    expect(calls[0]!.headers["X-Axel-Timestamp"]).toBe("1");
  });

  it("classifies 4xx (excluding 408/429) as dead so we don't retry forever", async () => {
    const fetchImpl: FetchLike = async () => ({ status: 401, async text() { return "nope"; } });
    const connector = createWebhookConnector(fetchImpl);
    const attempt = await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("{}")),
      destination("webhook", { url: "https://x", signing_secret: "s" }),
      { eventId: "evt-401" },
    );
    expect(attempt.status).toBe("dead");
  });

  it("classifies 429 as retry (rate limit, transient)", async () => {
    const fetchImpl: FetchLike = async () => ({ status: 429, async text() { return ""; } });
    const connector = createWebhookConnector(fetchImpl);
    const attempt = await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("{}")),
      destination("webhook", { url: "https://x", signing_secret: "s" }),
      { eventId: "evt-429" },
    );
    expect(attempt.status).toBe("retry");
  });

  it("classifies network errors as retry", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const connector = createWebhookConnector(fetchImpl);
    const attempt = await connector.deliver(
      toArrayBuffer(new TextEncoder().encode("{}")),
      destination("webhook", { url: "https://x", signing_secret: "s" }),
      { eventId: "evt-net" },
    );
    expect(attempt.status).toBe("retry");
    expect((attempt.response as { error: string }).error).toContain("ECONNRESET");
  });
});

describe("computeWebhookSignature", () => {
  it("matches node:crypto HMAC for SHA-256 by default", async () => {
    const { signature, header } = await computeWebhookSignature({
      secret: "k",
      body: "abc",
      timestampSeconds: 100,
    });
    const expected = createHmac("sha256", "k").update("100.abc").digest("hex");
    expect(signature).toBe(expected);
    expect(header).toBe(`t=100,v1=${expected}`);
  });
});

describe("generateWebhookSecret", () => {
  it("produces a base32 secret with the whsec_ prefix", () => {
    // Deterministic RNG so the test value is stable.
    const fixed = new Uint8Array(32);
    for (let i = 0; i < 32; i++) fixed[i] = i;
    const s = generateWebhookSecret(() => fixed);
    expect(s.startsWith("whsec_")).toBe(true);
    expect(s.length).toBe(56);
    // Crockford's alphabet: no I/L/O/U/0/1
    expect(s.slice(6)).not.toMatch(/[ILOU01]/);
  });
});

describe("buildSignedWebhookRequest", () => {
  it("returns a deterministic request shape suitable for previewing in the dashboard", async () => {
    const req = await buildSignedWebhookRequest({
      config: {
        url: "https://customer.test/in",
        signing_secret: "secret",
        __nowSeconds: () => 5,
      },
      body: new TextEncoder().encode("ping"),
      eventId: "evt-preview",
      destinationId: "dst-preview",
    });
    expect(req.url).toBe("https://customer.test/in");
    expect(req.method).toBe("POST");
    expect(req.timestamp).toBe(5);
    expect(req.headers["X-Axel-Event-Id"]).toBe("evt-preview");
    expect(req.headers["X-Axel-Webhook-Id"]).toBe("dst-preview");
    expect(req.headers["X-Axel-Signature"]).toMatch(/^t=5,v1=[0-9a-f]{64}$/);
  });
});

function destination(type: Destination["type"], config: WebhookDestinationConfig): Destination<WebhookDestinationConfig> {
  return {
    destination_id: "dest-1",
    workspace_id: "ws-1",
    type,
    config,
    credentials_ref: "cred-1",
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}
