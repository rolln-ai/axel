import { describe, expect, it } from "vitest";
import { diffJson, summariseDiff } from "../lib/json-diff";

describe("diffJson", () => {
  it("classifies leaf changes correctly", () => {
    const before = { a: 1, b: "x", c: true };
    const after = { a: 1, b: "y", d: false };
    const entries = diffJson(before, after);
    const summary = summariseDiff(entries);
    expect(summary.same).toBe(1); // a
    expect(summary.changed).toBe(1); // b
    expect(summary.removed).toBe(1); // c
    expect(summary.added).toBe(1); // d
  });

  it("recurses into nested objects with dot-paths", () => {
    const before = { user: { id: 1, name: "Ada" } };
    const after = { user: { id: 1, name: "Bob", email: "bob@x.com" } };
    const entries = diffJson(before, after);
    const paths = Object.fromEntries(entries.map((e) => [e.path, e.kind]));
    expect(paths["user.id"]).toBe("same");
    expect(paths["user.name"]).toBe("changed");
    expect(paths["user.email"]).toBe("added");
  });

  it("handles arrays index-by-index", () => {
    const before = { tags: ["a", "b", "c"] };
    const after = { tags: ["a", "z"] };
    const entries = diffJson(before, after);
    const paths = Object.fromEntries(entries.map((e) => [e.path, e.kind]));
    expect(paths["tags[0]"]).toBe("same");
    expect(paths["tags[1]"]).toBe("changed");
    expect(paths["tags[2]"]).toBe("removed");
  });

  it("treats type changes as a single 'changed' entry rather than recursing", () => {
    const before = { x: { nested: true } };
    const after = { x: "string-now" };
    const entries = diffJson(before, after);
    const xEntry = entries.find((e) => e.path === "x");
    expect(xEntry?.kind).toBe("changed");
    // No recursion into the object branch since the type changed.
    expect(entries.find((e) => e.path === "x.nested")).toBeUndefined();
  });

  it("returns same at root when payloads are identical", () => {
    const v = { a: 1, b: { c: [1, 2, 3] } };
    const entries = diffJson(v, JSON.parse(JSON.stringify(v)));
    expect(entries.every((e) => e.kind === "same")).toBe(true);
  });

  it("renders added/removed sub-trees as a single entry", () => {
    const before = { keep: 1 };
    const after = { keep: 1, addedSub: { deep: { value: 42 } } };
    const entries = diffJson(before, after);
    const added = entries.find((e) => e.path === "addedSub");
    expect(added?.kind).toBe("added");
    // We don't recurse into added sub-trees — the renderer prints the
    // whole branch so this stays a single row.
    expect(entries.find((e) => e.path.startsWith("addedSub."))).toBeUndefined();
  });
});
