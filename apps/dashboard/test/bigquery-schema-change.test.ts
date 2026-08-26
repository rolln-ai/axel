import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BqSchemaField } from "@axel/shared";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  introspect: vi.fn(),
}));

vi.mock("../lib/bigquery-auth", () => ({
  BIGQUERY_API_ROOT: "https://bigquery.googleapis.com/bigquery/v2",
}));

vi.mock("../lib/destination-inspect", () => ({
  getBigQueryDestinationAccess: mocks.access,
  introspectBigQueryDestination: mocks.introspect,
}));

import {
  findBigQueryField,
  planBigQueryFieldTypeChange,
  widenBigQueryDestinationField,
} from "../lib/bigquery-schema-change";

const integerSchema: BqSchemaField[] = [{
  name: "data",
  type: "RECORD",
  mode: "NULLABLE",
  fields: [
    {
      name: "properties",
      type: "RECORD",
      mode: "NULLABLE",
      fields: [
        { name: "total_taxes", type: "INTEGER", mode: "NULLABLE" },
        { name: "currency", type: "STRING", mode: "NULLABLE" },
      ],
    },
    { name: "tags", type: "STRING", mode: "REPEATED" },
  ],
}];

const floatSchema: BqSchemaField[] = [{
  ...integerSchema[0]!,
  fields: [{
    ...integerSchema[0]!.fields![0]!,
    fields: [
      { name: "total_taxes", type: "FLOAT64", mode: "NULLABLE" },
      { name: "currency", type: "STRING", mode: "NULLABLE" },
    ],
  }, integerSchema[0]!.fields![1]!],
}];

const planInput = {
  projectId: "demo-project",
  dataset: "demo_newsletter",
  table: "data",
  fields: integerSchema,
  fieldPath: "data.properties.total_taxes",
  fromType: "INT64",
  toType: "FLOAT64",
};

describe("BigQuery schema widening planner", () => {
  it("redefines the containing STRUCT while preserving siblings and arrays", () => {
    const plan = planBigQueryFieldTypeChange(planInput);

    expect(plan).toEqual({
      changed: true,
      fieldPath: "data.properties.total_taxes",
      fromType: "INT64",
      toType: "FLOAT64",
      rootField: "data",
      sql: "ALTER TABLE `demo-project.demo_newsletter.data` ALTER COLUMN `data` SET DATA TYPE STRUCT<`properties` STRUCT<`total_taxes` FLOAT64, `currency` STRING>, `tags` ARRAY<STRING>>",
    });
    expect(findBigQueryField(integerSchema, "DATA.Properties.Total_Taxes")?.type).toBe("INTEGER");
  });

  it("is idempotent when the live field is already FLOAT64", () => {
    expect(planBigQueryFieldTypeChange({ ...planInput, fields: floatSchema })).toMatchObject({
      changed: false,
      sql: null,
    });
  });

  it("only permits the intended INT64-to-FLOAT64 transition", () => {
    expect(() => planBigQueryFieldTypeChange({
      ...planInput,
      fromType: "STRING",
    })).toThrow(/bigquery_schema_widening_unsupported/);
    expect(() => planBigQueryFieldTypeChange({
      ...planInput,
      projectId: "demo-project`; DROP TABLE victims; --",
    })).toThrow(/identifier_rejected/);
  });

  it("refuses nested rewrites that could change field modes", () => {
    const required = structuredClone(integerSchema);
    required[0]!.fields![0]!.fields![1]!.mode = "REQUIRED";
    expect(() => planBigQueryFieldTypeChange({ ...planInput, fields: required }))
      .toThrow(/bigquery_schema_required_nested_field/);

    const repeated = structuredClone(integerSchema);
    repeated[0]!.fields![0]!.mode = "REPEATED";
    expect(() => planBigQueryFieldTypeChange({ ...planInput, fields: repeated }))
      .toThrow(/bigquery_schema_repeated_ancestor/);
  });
});

describe("BigQuery destination schema widening", () => {
  beforeEach(() => {
    mocks.access.mockReset();
    mocks.introspect.mockReset();
    mocks.access.mockResolvedValue({ projectId: "demo-project", accessToken: "ya29.test" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runs the planned DDL and verifies the live field before succeeding", async () => {
    mocks.introspect
      .mockResolvedValueOnce({ kind: "schema", fields: integerSchema })
      .mockResolvedValueOnce({ kind: "schema", fields: floatSchema });
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jobComplete: true }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await widenBigQueryDestinationField({
      destinationId: "dst_bigquery",
      workspaceId: "ws_demo_newsletter",
      dataset: "demo_newsletter",
      table: "data",
      fieldPath: "data.properties.total_taxes",
      fromType: "INT64",
      toType: "FLOAT64",
    });

    expect(result).toMatchObject({ changed: true, projectId: "demo-project" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      useLegacySql: false,
      query: expect.stringContaining("`total_taxes` FLOAT64"),
    });
    expect(mocks.introspect).toHaveBeenCalledTimes(2);
  });

  it("surfaces the permission required to run the schema job", async () => {
    mocks.introspect.mockResolvedValue({ kind: "schema", fields: integerSchema });
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({
        error: { message: "Permission bigquery.jobs.create denied on project demo-project" },
      }),
    })));

    await expect(widenBigQueryDestinationField({
      destinationId: "dst_bigquery",
      workspaceId: "ws_demo_newsletter",
      dataset: "demo_newsletter",
      table: "data",
      fieldPath: "data.properties.total_taxes",
      fromType: "INT64",
      toType: "FLOAT64",
    })).rejects.toThrow(/bigquery\.jobs\.create/);
  });
});
