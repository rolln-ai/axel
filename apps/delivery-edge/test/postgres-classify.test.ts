import { describe, expect, it } from "vitest";
import { classifyPgError } from "../src/index.ts";

/**
 * The destination that saved nothing failed because a permanent schema error
 * ("column does not exist", SQLSTATE 42703) was classified as transient and
 * retried forever — so it never dead-lettered and its message was never shown.
 * These lock the corrected classification + message surfacing.
 */
describe("classifyPgError", () => {
  it("dead-letters permanent schema errors by SQLSTATE", () => {
    for (const code of ["42P01", "42703", "42501", "23502", "22P02", "28P01"]) {
      const r = classifyPgError(Object.assign(new Error(`pg error ${code}`), { code }));
      expect(r.result).toBe("dead");
      expect(r.message).toContain(code);
    }
  });

  it("dead-letters 'column does not exist' even without a SQLSTATE", () => {
    const r = classifyPgError(new Error('column "payload" of relation "demo_events_raw" does not exist'));
    expect(r.result).toBe("dead");
    expect(r.message).toMatch(/does not exist/);
  });

  it("retries genuinely transient connection errors", () => {
    expect(classifyPgError(new Error("Connection terminated unexpectedly")).result).toBe("retry");
    expect(classifyPgError(Object.assign(new Error("timeout"), { code: "57P03" })).result).toBe("retry");
  });
});
