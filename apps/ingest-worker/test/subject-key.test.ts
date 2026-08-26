import { describe, expect, it } from "vitest";
import {
  extractSubjectPairs,
  extractSubjectValues,
  validateSubjectKeyPaths,
  type SubjectKeyPath,
} from "@axel/shared";

describe("validateSubjectKeyPaths", () => {
  it("accepts a valid config and trims paths", () => {
    const r = validateSubjectKeyPaths([
      { loc: "body", path: " customer.email ", kind: "email" },
      { loc: "header", path: "X-Customer-Id", kind: "id" },
    ]);
    expect(r).toEqual({
      ok: true,
      value: [
        { loc: "body", path: "customer.email", kind: "email" },
        { loc: "header", path: "X-Customer-Id", kind: "id" },
      ],
    });
  });

  it("treats null/empty as an empty config", () => {
    expect(validateSubjectKeyPaths(null)).toEqual({ ok: true, value: [] });
    expect(validateSubjectKeyPaths([])).toEqual({ ok: true, value: [] });
  });

  it("rejects a bad location, empty path, array-descent path, and unknown kind", () => {
    expect(validateSubjectKeyPaths([{ loc: "cookie", path: "x" }]).ok).toBe(false);
    expect(validateSubjectKeyPaths([{ loc: "body", path: "  " }]).ok).toBe(false);
    expect(validateSubjectKeyPaths([{ loc: "body", path: "items[].email" }]).ok).toBe(false);
    expect(validateSubjectKeyPaths([{ loc: "body", path: "x", kind: "ssn" }]).ok).toBe(false);
  });

  it("caps the number of keys and dedupes exact (loc,path)", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ loc: "body", path: `p${i}` }));
    expect(validateSubjectKeyPaths(many).ok).toBe(false);
    const dup = validateSubjectKeyPaths([
      { loc: "body", path: "email" },
      { loc: "body", path: "email" },
    ]);
    expect(dup.ok && dup.value.length).toBe(1);
  });
});

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const cfg = (paths: SubjectKeyPath[] | null | undefined) => ({ subject_key_paths: paths });
const noH: Record<string, string> = {};
const noQ: Record<string, string> = {};

describe("extractSubjectPairs", () => {
  it("keeps each value's kind and dedupes by (kind, value)", () => {
    const paths: SubjectKeyPath[] = [
      { loc: "body", path: "email", kind: "email" },
      { loc: "header", path: "X-Cust", kind: "id" },
    ];
    expect(
      extractSubjectPairs(cfg(paths), enc({ email: "a@b.com" }), { "x-cust": "cus_1" }, noQ),
    ).toEqual([
      { kind: "email", value: "a@b.com" },
      { kind: "id", value: "cus_1" },
    ]);
  });

  it("returns [] when unconfigured", () => {
    expect(extractSubjectPairs(cfg(undefined), enc({ email: "a@b.com" }), noH, noQ)).toEqual([]);
  });

  it("defaults a missing kind to the empty string", () => {
    expect(extractSubjectPairs(cfg([{ loc: "body", path: "id" }]), enc({ id: "x" }), noH, noQ)).toEqual([
      { kind: "", value: "x" },
    ]);
  });
});

describe("extractSubjectValues", () => {
  it("returns [] when unconfigured (default-inert)", () => {
    expect(extractSubjectValues(cfg(undefined), enc({ email: "a@b.com" }), noH, noQ)).toEqual([]);
    expect(extractSubjectValues(cfg(null), enc({ email: "a@b.com" }), noH, noQ)).toEqual([]);
    expect(extractSubjectValues(cfg([]), enc({ email: "a@b.com" }), noH, noQ)).toEqual([]);
  });

  it("extracts a body dot-path", () => {
    expect(
      extractSubjectValues(cfg([{ loc: "body", path: "data.customer.email", kind: "email" }]), enc({ data: { customer: { email: "a@b.com" } } }), noH, noQ),
    ).toEqual(["a@b.com"]);
  });

  it("extracts a header (case-insensitive)", () => {
    expect(
      extractSubjectValues(cfg([{ loc: "header", path: "X-Customer-Id" }]), enc({}), { "x-customer-id": "cus_9" }, noQ),
    ).toEqual(["cus_9"]);
  });

  it("extracts a query param", () => {
    expect(
      extractSubjectValues(cfg([{ loc: "query", path: "user_id" }]), enc({}), noH, { user_id: "u_42" }),
    ).toEqual(["u_42"]);
  });

  it("collects multiple distinct values across locations, de-duplicated in order", () => {
    const paths: SubjectKeyPath[] = [
      { loc: "body", path: "email", kind: "email" },
      { loc: "header", path: "x-cust", kind: "id" },
      { loc: "query", path: "email", kind: "email" }, // duplicate value -> dropped
    ];
    expect(
      extractSubjectValues(cfg(paths), enc({ email: "a@b.com" }), { "x-cust": "cus_1" }, { email: "a@b.com" }),
    ).toEqual(["a@b.com", "cus_1"]);
  });

  it("stringifies numeric/boolean leaves", () => {
    expect(extractSubjectValues(cfg([{ loc: "body", path: "id" }]), enc({ id: 1234 }), noH, noQ)).toEqual(["1234"]);
  });

  it("ignores missing paths, non-JSON bodies, non-scalar leaves, and arrays (never throws)", () => {
    const p: SubjectKeyPath[] = [{ loc: "body", path: "a.b" }];
    expect(extractSubjectValues(cfg(p), enc({ a: { c: 1 } }), noH, noQ)).toEqual([]); // missing
    expect(extractSubjectValues(cfg(p), new TextEncoder().encode("<xml/>"), noH, noQ)).toEqual([]); // not JSON
    expect(extractSubjectValues(cfg(p), enc({ a: { b: { nested: 1 } } }), noH, noQ)).toEqual([]); // object leaf
    expect(extractSubjectValues(cfg(p), enc({ a: { b: [1, 2] } }), noH, noQ)).toEqual([]); // array leaf
    expect(extractSubjectValues(cfg(p), enc({ a: { b: "" } }), noH, noQ)).toEqual([]); // empty string
    expect(extractSubjectValues(cfg([{ loc: "header", path: "x-missing" }]), enc({}), noH, noQ)).toEqual([]); // missing header
  });

  it("partial config still yields the resolvable values", () => {
    const paths: SubjectKeyPath[] = [
      { loc: "body", path: "missing.path" },
      { loc: "header", path: "x-present" },
    ];
    expect(extractSubjectValues(cfg(paths), enc({}), { "x-present": "here" }, noQ)).toEqual(["here"]);
  });
});
