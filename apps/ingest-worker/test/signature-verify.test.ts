import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  verifyProviderSignature,
  verifyStripeSignature,
  verifyGithubSignature,
  verifyShopifySignature,
  verifyCustomHmac,
  verifyChargebeeBasicAuth,
  verifyProviderSignatureWithSecrets,
} from "@axel/shared";

describe("verifyProviderSignatureWithSecrets — rotation window", () => {
  it("accepts a signature matching the current secret", async () => {
    const sig = hex(sign(SECRET, BODY));
    const res = await verifyProviderSignatureWithSecrets(
      { provider: "github", body: BODY, headers: { "x-hub-signature-256": `sha256=${sig}` } },
      [SECRET, "old_secret"],
    );
    expect(res.ok).toBe(true);
  });

  it("accepts a signature matching the PREVIOUS secret during the overlap", async () => {
    const old = "old_secret";
    const sig = hex(sign(old, BODY));
    const res = await verifyProviderSignatureWithSecrets(
      { provider: "github", body: BODY, headers: { "x-hub-signature-256": `sha256=${sig}` } },
      ["new_secret", old],
    );
    expect(res.ok).toBe(true);
  });

  it("rejects when the signature matches neither secret", async () => {
    const sig = hex(sign("wrong", BODY));
    const res = await verifyProviderSignatureWithSecrets(
      { provider: "github", body: BODY, headers: { "x-hub-signature-256": `sha256=${sig}` } },
      ["a", "b"],
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_signature");
  });

  it("returns missing_secret when no usable secrets are provided", async () => {
    const res = await verifyProviderSignatureWithSecrets(
      { provider: "github", body: BODY, headers: {} },
      [undefined, ""],
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("missing_secret");
  });
});

const SECRET = "whsec_test_super_secret";
const BODY = new TextEncoder().encode(JSON.stringify({ type: "invoice.paid", id: "evt_1" }));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function sign(secret: string, payload: string | Uint8Array): Uint8Array {
  return createHmac("sha256", secret).update(payload).digest();
}

describe("signature verifier — Stripe", () => {
  it("accepts a valid v1 signature inside the tolerance window", async () => {
    const ts = 1_710_000_000;
    const signed = `${ts}.${new TextDecoder().decode(BODY)}`;
    const sig = hex(sign(SECRET, signed));
    const result = await verifyStripeSignature(SECRET, BODY, {
      "stripe-signature": `t=${ts},v1=${sig}`,
    }, ts * 1000);
    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects when the timestamp falls outside the tolerance window", async () => {
    const ts = 1_710_000_000;
    const signed = `${ts}.${new TextDecoder().decode(BODY)}`;
    const sig = hex(sign(SECRET, signed));
    const result = await verifyStripeSignature(SECRET, BODY, {
      "stripe-signature": `t=${ts},v1=${sig}`,
    }, (ts + 1000) * 1000); // 1000s in the future = stale
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("stale_timestamp");
  });

  it("rejects when the signature is wrong", async () => {
    const ts = 1_710_000_000;
    const result = await verifyStripeSignature(SECRET, BODY, {
      "stripe-signature": `t=${ts},v1=deadbeef`,
    }, ts * 1000);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects when the header is missing", async () => {
    const result = await verifyStripeSignature(SECRET, BODY, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_signature");
  });

  it("rejects when the header has no `t` part", async () => {
    const result = await verifyStripeSignature(SECRET, BODY, {
      "stripe-signature": "v1=deadbeef",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_timestamp");
  });
});

describe("signature verifier — GitHub", () => {
  it("accepts a valid X-Hub-Signature-256", async () => {
    const sig = hex(sign(SECRET, BODY));
    const result = await verifyGithubSignature(SECRET, BODY, {
      "x-hub-signature-256": `sha256=${sig}`,
    });
    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects an invalid signature", async () => {
    const result = await verifyGithubSignature(SECRET, BODY, {
      "x-hub-signature-256":
        "sha256=0000000000000000000000000000000000000000000000000000000000000000",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("ignores the older sha1 header", async () => {
    const result = await verifyGithubSignature(SECRET, BODY, {
      "x-hub-signature": "sha1=anything",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_signature");
  });

  it("rejects when the prefix doesn't match", async () => {
    const sig = hex(sign(SECRET, BODY));
    const result = await verifyGithubSignature(SECRET, BODY, {
      "x-hub-signature-256": `sha512=${sig}`,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });
});

describe("signature verifier — Shopify", () => {
  it("accepts a valid X-Shopify-Hmac-Sha256 in base64", async () => {
    const sig = b64(sign(SECRET, BODY));
    const result = await verifyShopifySignature(SECRET, BODY, {
      "x-shopify-hmac-sha256": sig,
    });
    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("rejects when the base64 doesn't match", async () => {
    const result = await verifyShopifySignature(SECRET, BODY, {
      "x-shopify-hmac-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });
});

describe("signature verifier — Chargebee (Basic Auth)", () => {
  const CB_SECRET = "cb_user:cb_password";
  const authHeader = `Basic ${btoa(CB_SECRET)}`;

  it("accepts a matching Basic Auth header", () => {
    expect(verifyChargebeeBasicAuth(CB_SECRET, { authorization: authHeader })).toEqual({
      ok: true,
      reason: "ok",
    });
  });

  it("rejects a wrong credential", () => {
    const wrong = `Basic ${btoa("cb_user:nope")}`;
    expect(verifyChargebeeBasicAuth(CB_SECRET, { authorization: wrong })).toEqual({
      ok: false,
      reason: "invalid_signature",
    });
  });

  it("rejects when the Authorization header is missing", () => {
    expect(verifyChargebeeBasicAuth(CB_SECRET, {})).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("routes through the dispatcher for provider=chargebee", async () => {
    const ok = await verifyProviderSignature({
      provider: "chargebee",
      secret: CB_SECRET,
      body: BODY,
      headers: { authorization: authHeader },
    });
    expect(ok).toEqual({ ok: true, reason: "ok" });
    const bad = await verifyProviderSignature({
      provider: "chargebee",
      secret: CB_SECRET,
      body: BODY,
      headers: {},
    });
    expect(bad).toEqual({ ok: false, reason: "missing_signature" });
  });
});

describe("signature verifier — custom HMAC", () => {
  it("accepts our X-Axel-Signature scheme", async () => {
    const ts = 1_710_000_000;
    const signed = `${ts}.${new TextDecoder().decode(BODY)}`;
    const sig = hex(sign(SECRET, signed));
    const result = await verifyCustomHmac(SECRET, BODY, {
      "x-axel-signature": `t=${ts},v1=${sig}`,
    }, ts * 1000);
    expect(result).toEqual({ ok: true, reason: "ok" });
  });
});

describe("signature verifier — dispatcher", () => {
  it("routes 'stripe' to the Stripe verifier", async () => {
    const ts = 1_710_000_000;
    const signed = `${ts}.${new TextDecoder().decode(BODY)}`;
    const sig = hex(sign(SECRET, signed));
    const result = await verifyProviderSignature({
      provider: "stripe",
      secret: SECRET,
      body: BODY,
      headers: { "stripe-signature": `t=${ts},v1=${sig}` },
      now: ts * 1000,
    });
    expect(result.ok).toBe(true);
  });

  it("returns missing_secret when secret is empty", async () => {
    const result = await verifyProviderSignature({
      provider: "stripe",
      secret: "",
      body: BODY,
      headers: {},
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing_secret");
  });

  it("normalises header casing", async () => {
    const sig = hex(sign(SECRET, BODY));
    const result = await verifyProviderSignature({
      provider: "github",
      secret: SECRET,
      body: BODY,
      headers: { "X-Hub-Signature-256": `sha256=${sig}` },
    });
    expect(result.ok).toBe(true);
  });
});
