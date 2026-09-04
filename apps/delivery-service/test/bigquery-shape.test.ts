import { describe, expect, it } from "vitest";
import {
  bigQueryRowForEvent,
  compareBigQuerySchemas,
  expectedBigQuerySchema,
  normalizeBqType,
  typedColumns,
  type BqSchemaField,
} from "@axel/shared";

describe("expectedBigQuerySchema — nested_records", () => {
  const shape = (o: unknown) => expectedBigQuerySchema([o], "nested_records");

  it("normalizes every scalar leaf to STRING (numbers, bools, timestamps)", () => {
    expect(shape({ id: 42, active: true, name: "x", ts: "2026-01-01T00:00:00Z" })).toEqual([
      { name: "id", type: "STRING", mode: "NULLABLE" },
      { name: "active", type: "STRING", mode: "NULLABLE" },
      { name: "name", type: "STRING", mode: "NULLABLE" },
      { name: "ts", type: "STRING", mode: "NULLABLE" },
    ]);
  });

  it("maps objects to nested RECORD with STRING leaves", () => {
    expect(shape({ data: { subscriber: { id: 7 } } })).toEqual([
      {
        name: "data",
        type: "RECORD",
        mode: "NULLABLE",
        fields: [
          {
            name: "subscriber",
            type: "RECORD",
            mode: "NULLABLE",
            fields: [{ name: "id", type: "STRING", mode: "NULLABLE" }],
          },
        ],
      },
    ]);
  });

  it("primitive array → REPEATED STRING; object array → REPEATED RECORD; mixed → __json STRING", () => {
    expect(shape({ tags: ["a", "b"] })).toEqual([{ name: "tags", type: "STRING", mode: "REPEATED" }]);
    expect(shape({ items: [{ sku: "x" }, { sku: "y" }] })).toEqual([
      { name: "items", type: "RECORD", mode: "REPEATED", fields: [{ name: "sku", type: "STRING", mode: "NULLABLE" }] },
    ]);
    expect(shape({ mixed: [1, { a: 1 }] })).toEqual([{ name: "mixed__json", type: "STRING", mode: "NULLABLE" }]);
    expect(shape({ withNull: ["a", null] })).toEqual([{ name: "withNull__json", type: "STRING", mode: "NULLABLE" }]);
  });

  it("skips empty/all-null values and sanitizes field names", () => {
    expect(shape({ empty: {}, nulls: [null], "weird key!": 1, "9lead": 2 })).toEqual([
      { name: "weird_key_", type: "STRING", mode: "NULLABLE" },
      { name: "_9lead", type: "STRING", mode: "NULLABLE" },
    ]);
  });

  it("merges the union across samples and materializes a RECORD seen in any sample", () => {
    const fields = expectedBigQuerySchema(
      [{ a: 1 }, { b: 2 }, { a: { nested: 1 } }],
      "nested_records",
    );
    expect(fields.map((f) => `${f.name}:${f.type}`).sort()).toEqual(["a:RECORD", "b:STRING"]);
  });
});

describe("expectedBigQuerySchema — columns / json_column", () => {
  it("columns mode flattens to underscore-joined STRING columns", () => {
    expect(expectedBigQuerySchema([{ a: { b: 1 }, c: [1, 2] }], "columns")).toEqual([
      { name: "a_b", type: "STRING", mode: "NULLABLE" },
      { name: "c", type: "STRING", mode: "NULLABLE" },
    ]);
  });
  it("json_column mode is a single STRING payload column", () => {
    expect(expectedBigQuerySchema([{ anything: 1 }], "json_column", "body")).toEqual([
      { name: "body", type: "STRING", mode: "NULLABLE" },
    ]);
  });
  it("ignores non-object samples", () => {
    expect(expectedBigQuerySchema([42, "x", [1], null], "nested_records")).toEqual([]);
  });
});

describe("compareBigQuerySchemas", () => {
  const S = (name: string, type: string, mode: BqSchemaField["mode"] = "NULLABLE"): BqSchemaField => ({ name, type, mode });

  it("flags a typed existing column vs Axel's STRING (the headline case), incl. legacy names", () => {
    const expected = [S("amount", "STRING"), S("id", "STRING")];
    const existing = [S("amount", "INTEGER"), S("id", "INT64")];
    const r = compareBigQuerySchemas(expected, existing);
    expect(r.compatible).toBe(false);
    expect(r.conflicts.map((c) => `${c.path}:${c.kind}`)).toEqual([
      "amount:type_conflict",
      "id:type_conflict",
    ]);
    expect(r.conflicts[0]!.existing).toBe("INT64"); // INTEGER normalized
  });

  it("is compatible when the table columns are STRING/RECORD-of-STRING", () => {
    const r = compareBigQuerySchemas([S("a", "STRING")], [S("a", "STRING")]);
    expect(r).toEqual({ compatible: true, conflicts: [], additions: [], unused: [] });
  });

  it("recurses into RECORDs and flags a deep typed leaf", () => {
    const expected = [{ name: "data", type: "RECORD", mode: "NULLABLE" as const, fields: [S("id", "STRING")] }];
    const existing = [{ name: "data", type: "RECORD", mode: "NULLABLE" as const, fields: [S("id", "TIMESTAMP")] }];
    const r = compareBigQuerySchemas(expected, existing);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.path).toBe("data.id");
  });

  it("flags RECORD-vs-scalar and REQUIRED columns Axel won't send", () => {
    const rc = compareBigQuerySchemas([S("data", "RECORD")], [S("data", "STRING")]);
    expect(rc.conflicts[0]!.kind).toBe("record_scalar_conflict");
    const req = compareBigQuerySchemas([S("a", "STRING")], [S("a", "STRING"), S("must", "STRING", "REQUIRED")]);
    expect(req.conflicts.map((c) => c.kind)).toEqual(["missing_required"]);
  });

  it("treats extra Axel fields as additive (compatible) and extra table fields as unused", () => {
    const r = compareBigQuerySchemas([S("a", "STRING"), S("new", "STRING")], [S("a", "STRING"), S("legacy", "STRING")]);
    expect(r.compatible).toBe(true);
    expect(r.additions).toEqual(["new"]);
    expect(r.unused).toEqual(["legacy"]);
  });

  it("normalizeBqType maps legacy aliases", () => {
    expect(["INTEGER", "FLOAT", "BOOLEAN", "STRUCT", "STRING"].map(normalizeBqType)).toEqual([
      "INT64",
      "FLOAT64",
      "BOOL",
      "RECORD",
      "STRING",
    ]);
  });
});

describe("bigQueryRowForEvent — delivered-row preview", () => {
  it("json_column: whole body in one STRING column", () => {
    expect(bigQueryRowForEvent({ a: 1, b: [2, 3] }, "json_column", "payload")).toEqual({
      payload: '{"a":1,"b":[2,3]}',
    });
  });

  it("columns: flattens to underscore-joined stringified columns", () => {
    expect(
      bigQueryRowForEvent(
        { event: "x", data: { subscriber: { email: "a@b" }, items: [1, 2] } },
        "columns",
      ),
    ).toEqual({
      event: "x",
      data_subscriber_email: "a@b",
      data_items: "[1,2]",
    });
  });

  it("nested_records: RECORD hierarchy, scalar leaves stringified, arrays per rules", () => {
    expect(
      bigQueryRowForEvent(
        {
          id: 42,
          active: true,
          data: { email: "a@b" },
          tags: ["x", "y"],
          items: [{ n: 1 }, { n: 2 }],
        },
        "nested_records",
      ),
    ).toEqual({
      id: "42",
      active: "true",
      data: { email: "a@b" },
      tags: ["x", "y"],
      items: [{ n: "1" }, { n: "2" }],
    });
  });

  it("nested_records: non-mappable arrays go to a __json sidecar", () => {
    expect(bigQueryRowForEvent({ mixed: [1, "two", { k: 3 }] }, "nested_records")).toEqual({
      mixed__json: '[1,"two",{"k":3}]',
    });
  });

  it("returns null for a non-object body in an object mode (connector dead-letters)", () => {
    expect(bigQueryRowForEvent([1, 2, 3], "nested_records")).toBeNull();
    expect(bigQueryRowForEvent("hi", "columns")).toBeNull();
  });

  it("row keys always match the previewed schema's field names (no drift)", () => {
    const events = [
      { id: 1, data: { email: "a@b", score: 9 }, tags: ["x"], items: [{ n: 1 }] },
      { mixed: [1, "two", { k: 3 }], nested: { a: { b: "c" } } },
    ];
    for (const mode of ["nested_records", "columns"] as const) {
      for (const e of events) {
        const row = bigQueryRowForEvent(e, mode)!;
        const schema = expectedBigQuerySchema([e], mode);
        expect(new Set(Object.keys(row))).toEqual(new Set(schema.map((f) => f.name)));
      }
    }
  });
});

describe("expectedBigQuerySchema — typed_records", () => {
  const shape = (o: unknown) => expectedBigQuerySchema([o], "typed_records");

  it("preserves the source JSON type per scalar leaf", () => {
    expect(shape({ id: 42, ratio: 0.5, active: true, name: "x" })).toEqual([
      { name: "id", type: "INT64", mode: "NULLABLE" },
      { name: "ratio", type: "FLOAT64", mode: "NULLABLE" },
      { name: "active", type: "BOOL", mode: "NULLABLE" },
      { name: "name", type: "STRING", mode: "NULLABLE" },
    ]);
  });

  it("keeps RECORD nesting with typed leaves", () => {
    expect(shape({ data: { lead_score: 9, email: "a@b" } })).toEqual([
      {
        name: "data",
        type: "RECORD",
        mode: "NULLABLE",
        fields: [
          { name: "lead_score", type: "INT64", mode: "NULLABLE" },
          { name: "email", type: "STRING", mode: "NULLABLE" },
        ],
      },
    ]);
  });

  it("widens across samples: INT64+FLOAT64 → FLOAT64, INT64+STRING → STRING", () => {
    const merged = expectedBigQuerySchema(
      [{ a: 1, b: 2, c: 3 }, { a: 1.5, b: "two", c: 3 }],
      "typed_records",
    );
    expect(merged).toEqual([
      { name: "a", type: "FLOAT64", mode: "NULLABLE" },
      { name: "b", type: "STRING", mode: "NULLABLE" },
      { name: "c", type: "INT64", mode: "NULLABLE" },
    ]);
  });

  it("typed primitive arrays: uniform → REPEATED of that type, mixed → REPEATED STRING", () => {
    expect(shape({ scores: [1, 2, 3], tags: [1, "two"] })).toEqual([
      { name: "scores", type: "INT64", mode: "REPEATED" },
      { name: "tags", type: "STRING", mode: "REPEATED" },
    ]);
  });
});

describe("bigQueryRowForEvent — typed_records keeps native values", () => {
  it("emits native numbers/booleans, not stringified", () => {
    expect(
      bigQueryRowForEvent(
        { id: 42, active: true, ratio: 0.5, data: { lead_score: 9 }, scores: [1, 2] },
        "typed_records",
      ),
    ).toEqual({
      id: 42,
      active: true,
      ratio: 0.5,
      data: { lead_score: 9 },
      scores: [1, 2],
    });
  });

  it("row keys still match the previewed typed schema's field names", () => {
    const e = { id: 1, data: { email: "a@b", score: 9 }, scores: [1, 2] };
    const row = bigQueryRowForEvent(e, "typed_records")!;
    const schema = expectedBigQuerySchema([e], "typed_records");
    expect(new Set(Object.keys(row))).toEqual(new Set(schema.map((f) => f.name)));
  });
});

describe("compareBigQuerySchemas — typed_records vs an existing typed table", () => {
  it("clean typed data is compatible with a matching INT64/BOOL table", () => {
    // Newsletter-provider case: source sends real numbers/bools, table is typed.
    const expected = expectedBigQuerySchema(
      [{ data: { lead_score: 42, prospect: true } }],
      "typed_records",
    );
    const table: BqSchemaField[] = [
      {
        name: "data",
        type: "RECORD",
        mode: "NULLABLE",
        fields: [
          { name: "lead_score", type: "INTEGER", mode: "NULLABLE" }, // legacy alias
          { name: "prospect", type: "BOOLEAN", mode: "NULLABLE" },
        ],
      },
    ];
    expect(compareBigQuerySchemas(expected, table).compatible).toBe(true);
  });
});

describe("typedColumns", () => {
  it("returns empty when every leaf is STRING (or RECORD-of-STRING)", () => {
    const table: BqSchemaField[] = [
      { name: "id", type: "STRING", mode: "NULLABLE" },
      {
        name: "data",
        type: "RECORD",
        mode: "NULLABLE",
        fields: [{ name: "email", type: "STRING", mode: "NULLABLE" }],
      },
    ];
    expect(typedColumns(table)).toEqual([]);
  });

  it("flags non-STRING leaves with dotted paths, normalizing legacy names", () => {
    const table: BqSchemaField[] = [
      { name: "id", type: "STRING", mode: "NULLABLE" },
      { name: "amount", type: "INTEGER", mode: "NULLABLE" }, // legacy alias
      { name: "created_at", type: "TIMESTAMP", mode: "NULLABLE" },
      {
        name: "data",
        type: "RECORD",
        mode: "NULLABLE",
        fields: [
          { name: "email", type: "STRING", mode: "NULLABLE" },
          { name: "score", type: "FLOAT", mode: "NULLABLE" },
        ],
      },
    ];
    expect(typedColumns(table)).toEqual([
      { path: "amount", type: "INT64" },
      { path: "created_at", type: "TIMESTAMP" },
      { path: "data.score", type: "FLOAT64" },
    ]);
  });
});
