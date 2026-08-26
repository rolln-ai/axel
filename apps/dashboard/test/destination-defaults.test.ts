import { describe, expect, it } from "vitest";
import {
  applyDestinationFieldValue,
  CREATABLE_DESTINATION_SCHEMAS,
  DESTINATION_SCHEMAS,
  HTTP_PRESET_FIELD_DEFAULTS,
  schemaFor,
} from "../lib/destination-defaults";

describe("destination defaults", () => {
  it("keeps Databricks SQL available for legacy rows but hidden from create flows", () => {
    expect(DESTINATION_SCHEMAS.map((schema) => schema.type)).toContain("databricks_sql");
    expect(CREATABLE_DESTINATION_SCHEMAS.map((schema) => schema.type)).not.toContain("databricks_sql");
  });

  it("offers BigQuery as a creatable destination with an encrypted service-account key", () => {
    expect(CREATABLE_DESTINATION_SCHEMAS.map((schema) => schema.type)).toContain("bigquery");
    const bq = schemaFor("bigquery");
    expect(bq.blurb).toContain("dataset + table chosen per route");
    expect(bq.fields.map((f) => f.key)).toEqual(["project_id", "service_account_json"]);
    const sa = bq.fields.find((f) => f.key === "service_account_json");
    expect(sa).toMatchObject({ kind: "secret", inputType: "textarea", required: true });
    expect(sa?.hint).toContain("nested RECORD / REPEATED schemas");
    // The project is destination-level config; dataset.table is selected per route.
    expect(bq.fields.find((f) => f.key === "project_id")).toMatchObject({ kind: "config" });
  });

  it("asks for an optional S3-compatible endpoint", () => {
    const s3 = schemaFor("s3");
    const endpoint = s3.fields.find((field) => field.key === "endpoint");
    const addressingStyle = s3.fields.find((field) => field.key === "addressing_style");

    expect(endpoint).toMatchObject({
      kind: "config",
      inputType: "url",
      required: false,
      placeholder: "https://t3.storage.dev",
    });
    expect(addressingStyle).toMatchObject({
      kind: "config",
      inputType: "select",
      defaultValue: "path",
      required: false,
    });
    expect(addressingStyle?.options?.map((option) => option.value)).toEqual([
      "path",
      "virtual_hosted",
    ]);
  });
});

describe("http preset defaults", () => {
  const http = schemaFor("http");
  const presetField = http.fields.find((f) => f.key === "preset");

  it("covers every preset option (no option can be a silent no-op again)", () => {
    const optionValues = presetField?.options?.map((o) => o.value) ?? [];
    expect(optionValues.length).toBeGreaterThan(0);
    for (const value of optionValues) {
      expect(HTTP_PRESET_FIELD_DEFAULTS, `preset "${value}" has no defaults entry`).toHaveProperty(value);
    }
  });

  it("only implies values that are real http config fields with valid select options", () => {
    const fieldByKey = new Map(http.fields.map((f) => [f.key, f]));
    for (const [preset, implied] of Object.entries(HTTP_PRESET_FIELD_DEFAULTS)) {
      for (const [key, value] of Object.entries(implied)) {
        const field = fieldByKey.get(key);
        expect(field, `preset "${preset}" implies unknown field "${key}"`).toBeDefined();
        expect(field?.kind).toBe("config");
        if (field?.inputType === "select") {
          expect(field.options?.map((o) => o.value)).toContain(value);
        }
      }
    }
  });

  it("prefills Datadog's api_key auth header when the preset is picked", () => {
    const next = applyDestinationFieldValue({ url: "https://example.com" }, "preset", "datadog");
    expect(next).toEqual({
      url: "https://example.com",
      preset: "datadog",
      auth_type: "api_key",
      api_key_header: "DD-API-KEY",
    });
  });

  it("resets paste-the-URL presets to no auth", () => {
    const next = applyDestinationFieldValue({ auth_type: "bearer" }, "preset", "slack");
    expect(next).toMatchObject({ preset: "slack", auth_type: "none" });
  });

  it("leaves the generic preset and non-preset edits alone", () => {
    expect(applyDestinationFieldValue({ auth_type: "bearer" }, "preset", "generic")).toEqual({
      auth_type: "bearer",
      preset: "generic",
    });
    // A later manual edit wins over what the preset implied.
    const afterPreset = applyDestinationFieldValue({}, "preset", "datadog");
    expect(applyDestinationFieldValue(afterPreset, "api_key_header", "X-Custom")).toMatchObject({
      api_key_header: "X-Custom",
      auth_type: "api_key",
    });
  });
});
