import { describe, expect, it } from "vitest";
import { resolveOrderingKey, shardFor } from "@axel/shared";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const base = { workspace_id: "ws_1", source_id: "src_1" };
const noHeaders: Record<string, string> = {};

describe("resolveOrderingKey", () => {
  it("returns null when ordering is disabled (default-off)", () => {
    expect(resolveOrderingKey(base, enc({ account: { id: "acct_9" } }), noHeaders)).toBeNull();
    expect(
      resolveOrderingKey({ ...base, ordering_enabled: false, ordering_key_path: "account.id" }, enc({ account: { id: "acct_9" } }), noHeaders),
    ).toBeNull();
  });

  it("extracts and namespaces a dot-path key", () => {
    expect(
      resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_path: "data.account.id" },
        enc({ data: { account: { id: "acct_9" } } }),
        noHeaders,
      ),
    ).toBe("ws_1:src_1:acct_9");
  });

  it("stringifies numeric and boolean leaves", () => {
    expect(
      resolveOrderingKey({ ...base, ordering_enabled: true, ordering_key_path: "seq" }, enc({ seq: 42 }), noHeaders),
    ).toBe("ws_1:src_1:42");
    expect(
      resolveOrderingKey({ ...base, ordering_enabled: true, ordering_key_path: "flag" }, enc({ flag: false }), noHeaders),
    ).toBe("ws_1:src_1:false");
  });

  it("reads a header (case-insensitive) when configured", () => {
    expect(
      resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_header: "X-Account-Id" },
        enc({}),
        { "x-account-id": "acct_h" },
      ),
    ).toBe("ws_1:src_1:acct_h");
  });

  it("prefers the header over the path when both resolve", () => {
    expect(
      resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_header: "x-key", ordering_key_path: "id" },
        enc({ id: "from_body" }),
        { "x-key": "from_header" },
      ),
    ).toBe("ws_1:src_1:from_header");
  });

  it("falls back to the path when the configured header is absent", () => {
    expect(
      resolveOrderingKey(
        { ...base, ordering_enabled: true, ordering_key_header: "x-missing", ordering_key_path: "id" },
        enc({ id: "from_body" }),
        noHeaders,
      ),
    ).toBe("ws_1:src_1:from_body");
  });

  it("returns null for a missing path, non-JSON body, or non-scalar leaf (never throws/drops)", () => {
    const enabled = { ...base, ordering_enabled: true, ordering_key_path: "a.b" };
    expect(resolveOrderingKey(enabled, enc({ a: { c: 1 } }), noHeaders)).toBeNull(); // missing
    expect(resolveOrderingKey(enabled, new TextEncoder().encode("<xml/>"), noHeaders)).toBeNull(); // not JSON
    expect(resolveOrderingKey(enabled, enc({ a: { b: { nested: 1 } } }), noHeaders)).toBeNull(); // object leaf
    expect(resolveOrderingKey(enabled, enc({ a: { b: [1, 2] } }), noHeaders)).toBeNull(); // array leaf
    expect(resolveOrderingKey(enabled, enc({ a: { b: "" } }), noHeaders)).toBeNull(); // empty string
  });

  it("does not descend arrays (an ordering key must be a single deterministic value)", () => {
    expect(
      resolveOrderingKey({ ...base, ordering_enabled: true, ordering_key_path: "items.id" }, enc({ items: [{ id: "x" }] }), noHeaders),
    ).toBeNull();
  });

  // Golden: with ordering off, the resolver yields null so the caller shards by
  // event_id — byte-identical to baseline. No ordered source can change the
  // shard chosen for an unordered one.
  it("preserves baseline event_id sharding when ordering is off", () => {
    const eventId = "0190a9c2-1234-7abc-8def-0123456789ab";
    const key = resolveOrderingKey({ ...base, ordering_key_path: "account.id" }, enc({ account: { id: "acct_9" } }), noHeaders);
    expect(key).toBeNull();
    expect(shardFor(key ?? eventId)).toBe(shardFor(eventId));
  });
});
