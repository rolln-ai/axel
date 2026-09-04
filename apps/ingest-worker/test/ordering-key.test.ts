import { describe, expect, it } from "vitest";
import { resolveOrderingKey, shardFor } from "@axel/shared";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const base = { workspace_id: "ws_1", source_id: "src_1" };
const noHeaders: Record<string, string> = {};
const hmacSecret = "ordering-test-secret-32-characters-minimum";

describe("resolveOrderingKey", () => {
  it("returns null when ordering is disabled (default-off)", async () => {
    expect(await resolveOrderingKey(base, enc({ account: { id: "acct_9" } }), noHeaders, hmacSecret)).toBeNull();
    expect(
      await resolveOrderingKey({ ...base, ordering_enabled: false, ordering_key_path: "account.id" }, enc({ account: { id: "acct_9" } }), noHeaders, hmacSecret),
    ).toBeNull();
  });

  it("pseudonymizes a dot-path key with a stable keyed HMAC", async () => {
    const key = await resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_path: "data.account.id" },
        enc({ data: { account: { id: "acct_9" } } }),
        noHeaders,
        hmacSecret,
      );
    expect(key).toMatch(/^ord_v1_[a-f0-9]{64}$/);
    expect(key).not.toContain("acct_9");
    expect(await resolveOrderingKey(
      { ...base, ordering_enabled: true, ordering_key_path: "data.account.id" },
      enc({ data: { account: { id: "acct_9" } } }),
      noHeaders,
      hmacSecret,
    )).toBe(key);
  });

  it("pseudonymizes low-entropy numeric and boolean leaves", async () => {
    const numeric = await resolveOrderingKey(
      { ...base, ordering_enabled: true, ordering_key_path: "seq" },
      enc({ seq: 1 }),
      noHeaders,
      hmacSecret,
    );
    const boolean = await resolveOrderingKey(
      { ...base, ordering_enabled: true, ordering_key_path: "flag" },
      enc({ flag: false }),
      noHeaders,
      hmacSecret,
    );
    expect(numeric).toMatch(/^ord_v1_[a-f0-9]{64}$/);
    expect(boolean).toMatch(/^ord_v1_[a-f0-9]{64}$/);
    expect(numeric).not.toContain(":1");
    expect(boolean).not.toContain("false");
  });

  it("rejects a weak HMAC key before producing an ordering value", async () => {
    await expect(resolveOrderingKey(
      { ...base, ordering_enabled: true, ordering_key_path: "seq" },
      enc({ seq: 1 }),
      noHeaders,
      "too-short",
    )).rejects.toThrow("ordering_key_hmac_secret_invalid");
  });

  it("reads a header case-insensitively when configured", async () => {
    expect(await resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_header: "X-Account-Id" },
        enc({}),
        { "x-account-id": "acct_h" },
        hmacSecret,
      )).toMatch(/^ord_v1_[a-f0-9]{64}$/);
  });

  it("prefers the header over the path when both resolve", async () => {
    const fromHeader = await resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_header: "x-key", ordering_key_path: "id" },
        enc({ id: "from_body" }),
        { "x-key": "from_header" },
        hmacSecret,
      );
    const headerOnly = await resolveOrderingKey(
      { ...base, ordering_enabled: true, ordering_key_header: "x-key" },
      enc({}),
      { "x-key": "from_header" },
      hmacSecret,
    );
    expect(fromHeader).toBe(headerOnly);
  });

  it("falls back to the path when the configured header is absent", async () => {
    const fallback = await resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_header: "x-missing", ordering_key_path: "id" },
        enc({ id: "from_body" }),
        noHeaders,
        hmacSecret,
      );
    const pathOnly = await resolveOrderingKey(
      { ...base, ordering_enabled: true, ordering_key_path: "id" },
      enc({ id: "from_body" }),
      noHeaders,
      hmacSecret,
    );
    expect(fallback).toBe(pathOnly);
  });

  it("returns null for a missing path, non-JSON body, or non-scalar leaf", async () => {
    const enabled = { ...base, ordering_enabled: true, ordering_key_path: "a.b" };
    expect(await resolveOrderingKey(enabled, enc({ a: { c: 1 } }), noHeaders, hmacSecret)).toBeNull();
    expect(await resolveOrderingKey(enabled, new TextEncoder().encode("<xml/>"), noHeaders, hmacSecret)).toBeNull();
    expect(await resolveOrderingKey(enabled, enc({ a: { b: { nested: 1 } } }), noHeaders, hmacSecret)).toBeNull();
    expect(await resolveOrderingKey(enabled, enc({ a: { b: [1, 2] } }), noHeaders, hmacSecret)).toBeNull();
    expect(await resolveOrderingKey(enabled, enc({ a: { b: "" } }), noHeaders, hmacSecret)).toBeNull();
  });

  it("does not descend arrays", async () => {
    expect(
      await resolveOrderingKey({ ...base, ordering_enabled: true, ordering_key_path: "items.id" }, enc({ items: [{ id: "x" }] }), noHeaders, hmacSecret),
    ).toBeNull();
  });

  // Golden: with ordering off, the resolver yields null so the caller shards by
  // event_id — byte-identical to baseline. No ordered source can change the
  // shard chosen for an unordered one.
  it("preserves baseline event_id sharding when ordering is off", async () => {
    const eventId = "0190a9c2-1234-7abc-8def-0123456789ab";
    const key = await resolveOrderingKey({ ...base, ordering_key_path: "account.id" }, enc({ account: { id: "acct_9" } }), noHeaders, hmacSecret);
    expect(key).toBeNull();
    expect(shardFor(key ?? eventId)).toBe(shardFor(eventId));
  });
});
