import { describe, expect, it, vi } from "vitest";
import { fetchPayloadForR2Key } from "../lib/sample-payload";

describe("fetchPayloadForR2Key", () => {
  // Locks in the contract that the fetcher returns `null` (not a
  // GENERIC_SAMPLE placeholder) on every failure path. The placeholder
  // fallback poisoned Data Contracts inference: a newsletter provider source with 800,000
  // real events ended up clustered as Stripe `payment_intent.succeeded`
  // because the empty-CF-creds branch returned a Stripe-shaped sample
  // and the sampler clustered the same shape across every "fetch".
  it("returns null when CLOUDFLARE_API_TOKEN is missing", async () => {
    const result = await fetchPayloadForR2Key("any/key", {
      env: { CLOUDFLARE_ACCOUNT_ID: "acct_x" },
      fetchImpl: () => {
        throw new Error("fetch should not be called when creds are missing");
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when CLOUDFLARE_API_TOKEN is the empty string", async () => {
    // The prod misconfig that caused the bug: encrypted env var present
    // in Vercel but with an empty value.
    const result = await fetchPayloadForR2Key("any/key", {
      env: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" },
    });
    expect(result).toBeNull();
  });

  it("returns null on non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));
    const result = await fetchPayloadForR2Key("missing/key", {
      env: { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns null when fetch throws (network error)", async () => {
    const result = await fetchPayloadForR2Key("any/key", {
      env: { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" },
      fetchImpl: (() => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
    });
    expect(result).toBeNull();
  });

  it("returns parsed JSON on success", async () => {
    const fetchImpl = vi.fn(
      async () => new Response('{"hello":"world"}', { status: 200 }),
    );
    const result = await fetchPayloadForR2Key("ok/key", {
      env: { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ hello: "world" });
  });

  it("wraps non-JSON bodies into a { raw } shape so preview still renders", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("not json at all", { status: 200 }),
    );
    const result = await fetchPayloadForR2Key("ok/key", {
      env: { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acct" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ raw: "not json at all" });
  });
});
