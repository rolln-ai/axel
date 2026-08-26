import { describe, expect, it } from "vitest";
import { projectPayload } from "@axel/shared";

describe("projectPayload — field selection", () => {
  it("projects only the selected dotted paths, rebuilding the nested shape", () => {
    expect(projectPayload({ a: { b: 1, c: 2 }, d: 3 }, ["a.b", "d"])).toEqual({ a: { b: 1 }, d: 3 });
  });

  it("returns the payload unchanged for null/empty paths", () => {
    const p = { a: 1 };
    expect(projectPayload(p, null)).toBe(p);
    expect(projectPayload(p, [])).toBe(p);
  });

  it("skips missing paths and passes non-object payloads through", () => {
    expect(projectPayload({ a: 1 }, ["a", "missing.x"])).toEqual({ a: 1 });
    expect(projectPayload("scalar", ["a"])).toBe("scalar");
    expect(projectPayload([1, 2], ["a"])).toEqual([1, 2]);
  });

  it("never pollutes Object.prototype via a __proto__/constructor/prototype path", () => {
    // A field_selection path through a prototype key must be skipped entirely so
    // the write-back can't mutate the global prototype (CodeQL prototype-pollution).
    const out = projectPayload({ a: 1 }, ["__proto__.polluted", "constructor.x", "prototype.y", "a"]);
    expect(out).toEqual({ a: 1 }); // only the safe field survives
    expect(Object.prototype).not.toHaveProperty("polluted");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
