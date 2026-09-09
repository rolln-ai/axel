import { describe, expect, it } from "vitest";
import { allowsLegacyQueryToken } from "../src/legacy-query-token.js";

const start = Date.parse("2026-01-01T00:00:00Z");
const policy = JSON.stringify({ src_existing: { starts_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-03T00:00:00Z" } });

describe("legacy query credential migration", () => {
  it("only accepts the named source during its bounded window", () => {
    expect(allowsLegacyQueryToken(policy, "src_existing", start)).toBe(true);
    expect(allowsLegacyQueryToken(policy, "src_other", start)).toBe(false);
    expect(allowsLegacyQueryToken(policy, "src_existing", start - 1)).toBe(false);
    expect(allowsLegacyQueryToken(policy, "src_existing", start + 48 * 3600000)).toBe(false);
  });

  it.each([undefined, "", "not json", "null", "[]", '{"src_existing":true}', '{"src_existing":{"starts_at":"bad","expires_at":"bad"}}', '{"src_existing":{"starts_at":"2026-01-01","expires_at":"2027-01-01"}}', '{"src_existing":{"starts_at":"2026-01-03","expires_at":"2026-01-01"}}'])("rejects invalid or unbounded config %s", (config) => {
    expect(allowsLegacyQueryToken(config, "src_existing", start)).toBe(false);
  });
});
