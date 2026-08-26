import { describe, expect, it } from "vitest";
import {
  coercePgValue,
  flattenPayloadToColumns,
  inferPgType,
  PG_IDENT_MAX_BYTES,
  PG_OVERFLOW_COLUMN,
  quotePgIdent,
  quotePgTable,
  splitPgTable,
  widenPgType,
  type PgColumn,
} from "@axel/shared";

const byName = (cols: PgColumn[]) => new Map(cols.map((c) => [c.name, c]));

describe("flattenPayloadToColumns — dot notation", () => {
  it("flattens nested objects into quoted dotted leaf columns", () => {
    const cols = flattenPayloadToColumns({
      user: { email: "a@b.test", age: 30 },
      kind: "signup",
      active: true,
    });
    const m = byName(cols);
    expect(m.get("user.email")).toMatchObject({ type: "text", value: "a@b.test" });
    expect(m.get("user.age")).toMatchObject({ type: "bigint", value: 30 });
    expect(m.get("kind")).toMatchObject({ type: "text", value: "signup" });
    expect(m.get("active")).toMatchObject({ type: "boolean", value: true });
  });

  it("treats arrays as a single jsonb leaf (never positional columns)", () => {
    const cols = flattenPayloadToColumns({ tags: ["a", "b"] });
    expect(cols).toHaveLength(1);
    expect(cols[0]).toMatchObject({ name: "tags", type: "jsonb", value: ["a", "b"] });
  });

  it("skips null/undefined leaves (can't infer a type from null)", () => {
    const cols = flattenPayloadToColumns({ a: 1, b: null, c: undefined });
    expect(cols.map((c) => c.name)).toEqual(["a"]);
  });

  it("infers numeric (not float) for fractional numbers and bigint for integers", () => {
    const m = byName(flattenPayloadToColumns({ i: 7, f: 3.14, big: 61515173175 }));
    expect(m.get("i")!.type).toBe("bigint");
    expect(m.get("f")!.type).toBe("numeric");
    expect(m.get("big")!.type).toBe("bigint");
  });

  it("wraps non-object payloads as a `value` column instead of throwing", () => {
    expect(flattenPayloadToColumns("hello")).toEqual([{ name: "value", type: "text", value: "hello" }]);
    expect(flattenPayloadToColumns([1, 2])).toEqual([{ name: "value", type: "jsonb", value: [1, 2] }]);
    expect(flattenPayloadToColumns(null)).toEqual([]);
  });
});

describe("flattenPayloadToColumns — sanitization (never throw)", () => {
  it("replaces invalid identifier chars and fixes leading digits", () => {
    const m = byName(
      flattenPayloadToColumns({ "content-type": "x", "has space": "y", "1st": "z", "🍺beer": "w" }),
    );
    expect(m.has("content_type")).toBe(true);
    expect(m.has("has_space")).toBe(true);
    expect(m.has("_1st")).toBe(true);
    // unicode key sanitizes to a safe name (exact spelling not important).
    expect([...m.keys()].some((k) => /beer/.test(k))).toBe(true);
  });

  it("keeps original-key dots distinct from nested paths (a.b vs {a:{b}})", () => {
    const flat = byName(flattenPayloadToColumns({ "a.b": 1 }));
    const nested = byName(flattenPayloadToColumns({ a: { b: 1 } }));
    // {"a.b"} sanitizes its single key's dot to "_"; {a:{b}} keeps the path dot.
    expect(flat.has("a_b")).toBe(true);
    expect(nested.has("a.b")).toBe(true);
  });
});

describe("flattenPayloadToColumns — limits & reserved columns", () => {
  it("never produces a column longer than 63 bytes, with a stable hash suffix", () => {
    const longKey = "x".repeat(200);
    const a = flattenPayloadToColumns({ [longKey]: 1 })[0]!.name;
    const b = flattenPayloadToColumns({ [longKey]: 1 })[0]!.name;
    expect(new TextEncoder().encode(a).length).toBeLessThanOrEqual(PG_IDENT_MAX_BYTES);
    expect(a).toBe(b); // deterministic
  });

  it("remaps incoming fields that clash with reserved id/received_at", () => {
    const m = byName(flattenPayloadToColumns({ id: 5, received_at: "t", ok: 1 }));
    expect(m.has("id")).toBe(false);
    expect(m.has("received_at")).toBe(false);
    expect(m.has("id__field")).toBe(true);
    expect(m.has("received_at__field")).toBe(true);
    expect(m.has("ok")).toBe(true);
  });

  it("spills over-budget leaves into one jsonb _extra column (lossless)", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 10; i++) wide[`k${i}`] = i;
    const cols = flattenPayloadToColumns(wide, { maxColumns: 4 });
    expect(cols.filter((c) => c.name !== PG_OVERFLOW_COLUMN)).toHaveLength(4);
    const extra = cols.find((c) => c.name === PG_OVERFLOW_COLUMN)!;
    expect(extra.type).toBe("jsonb");
    expect(Object.keys(extra.value as object)).toHaveLength(6);
  });

  it("stops recursing at the depth cap and stores the subtree as jsonb", () => {
    const cols = flattenPayloadToColumns({ a: { b: { c: { d: 1 } } } }, { maxDepth: 2 });
    const leaf = cols[0]!;
    expect(leaf.type).toBe("jsonb");
    expect(leaf.name).toBe("a.b.c");
    expect(leaf.value).toEqual({ d: 1 });
  });
});

describe("type widening + coercion + quoting", () => {
  it("widens monotonically toward text as the universal sink", () => {
    expect(widenPgType("bigint", "numeric")).toBe("numeric");
    expect(widenPgType("bigint", "text")).toBe("text");
    expect(widenPgType("boolean", "bigint")).toBe("bigint");
    expect(widenPgType("jsonb", "text")).toBe("text");
    expect(widenPgType("jsonb", "bigint")).toBe("text");
    expect(widenPgType("text", "text")).toBe("text");
  });

  it("coerces values to the column type without double-encoding scalars", () => {
    expect(coercePgValue(42, "bigint")).toEqual({ json: false, value: 42 });
    expect(coercePgValue({ a: 1 }, "jsonb")).toEqual({ json: true, value: { a: 1 } });
    expect(coercePgValue({ a: 1 }, "text")).toEqual({ json: false, value: '{"a":1}' });
    expect(coercePgValue(42, "text")).toEqual({ json: false, value: "42" });
  });

  it("quotes identifiers (dots literal) and rejects unsafe ones", () => {
    expect(quotePgIdent("user.email")).toBe('"user.email"');
    expect(() => quotePgIdent('a";DROP')).toThrow();
  });

  it("splits + quotes TABLE references on the first dot (schema-qualified targets)", () => {
    // Column identifiers keep literal dots; TABLE references must split so a
    // non-public schema routes correctly instead of becoming a literal
    // "app.events" table in the public schema.
    expect(splitPgTable("app.events")).toEqual({ schema: "app", table: "events" });
    expect(splitPgTable("events")).toEqual({ schema: "public", table: "events" });
    expect(quotePgTable("app.events")).toBe('"app"."events"');
    expect(quotePgTable("events")).toBe('"public"."events"');
    // Distinct from the column path: a column called "app.events" stays one ident.
    expect(quotePgIdent("app.events")).toBe('"app.events"');
    expect(() => quotePgTable('app";DROP.events')).toThrow();
  });

  it("inferPgType covers the scalar/array/object matrix", () => {
    expect(inferPgType(true)).toBe("boolean");
    expect(inferPgType(1)).toBe("bigint");
    expect(inferPgType(1.5)).toBe("numeric");
    expect(inferPgType("s")).toBe("text");
    expect(inferPgType([1])).toBe("jsonb");
    expect(inferPgType({ a: 1 })).toBe("jsonb");
  });
});
