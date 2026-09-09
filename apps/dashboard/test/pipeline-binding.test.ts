import { describe, expect, it } from "vitest";
import type { BigQueryBinding } from "@axel/shared";
import {
  PIPELINE_BINDING_REQUIRED,
  bigQueryModeForBinding,
  formatBigQueryTarget,
  normalizeBigQueryDatasetName,
  normalizeBigQueryTableName,
  normalizeBigQueryTarget,
  pipelineBindingForNewDestination,
  prepareBigQueryBindingForCreate,
  prepareBigQueryBindingForEdit,
} from "../lib/pipeline-binding";

describe("pipelineBindingForNewDestination", () => {
  it.each(["postgres", "bigquery", "databricks_sql"])("requires explicit permission for %s schema additions", (type) => {
    expect(pipelineBindingForNewDestination(type, "events")?.schema_evolution).toBeUndefined();
    expect(pipelineBindingForNewDestination(type, "events", "unknown")?.schema_evolution).toBeUndefined();
    expect(pipelineBindingForNewDestination(type, "events", true)?.schema_evolution).toBeUndefined();
    expect(pipelineBindingForNewDestination(type, "events", "add_columns")?.schema_evolution).toBe("add_columns");
  });

  it("preserves the explicit BigQuery schema policy through create and edit normalization", () => {
    const binding = { dataset: "analytics", table: "events", mode: "typed_records", schema_evolution: "add_columns" };
    expect(prepareBigQueryBindingForCreate(binding)).toEqual({ binding });
    expect(prepareBigQueryBindingForEdit(binding, binding)).toEqual({ binding });
    expect(prepareBigQueryBindingForEdit({ ...binding, schema_evolution: "manual" }, binding))
      .toEqual({ binding: { ...binding, schema_evolution: "manual" } });
  });
  it("shapes a Postgres binding the connector can read (binding.table), defaulting to dotted_columns", () => {
    // delivery-edge resolvePostgresBinding reads binding.table + binding.mode.
    // New PG tables default to dotted_columns (auto-expand dot-notation columns).
    expect(pipelineBindingForNewDestination("postgres", "events")).toEqual({
      table: "events",
      mode: "dotted_columns",
    });
  });

  it("shapes a Mongo binding the connector can read (binding.collection)", () => {
    expect(pipelineBindingForNewDestination("mongodb", "events")).toEqual({
      collection: "events",
    });
  });

  it("shapes a Databricks SQL binding with the typed_columns default", () => {
    expect(pipelineBindingForNewDestination("databricks_sql", "raw_events")).toEqual({
      table: "raw_events",
      mode: "typed_columns",
    });
  });

  it("shapes a Databricks volume binding (binding.volume)", () => {
    expect(pipelineBindingForNewDestination("databricks_volume", "landing")).toEqual({
      volume: "landing",
    });
  });

  it("shapes a BigQuery binding with the recommended typed_records default", () => {
    expect(pipelineBindingForNewDestination("bigquery", "events")).toEqual({
      table: "events",
      mode: "typed_records",
    });
    expect(pipelineBindingForNewDestination("bigquery", "analytics.events")).toEqual({
      dataset: "analytics",
      table: "events",
      mode: "typed_records",
    });
  });

  it("defaults new BigQuery picker bindings to typed without changing saved modes", () => {
    const typedBinding: BigQueryBinding = { dataset: "analytics", table: "events", mode: "typed_records" };
    const nestedBinding: BigQueryBinding = { dataset: "analytics", table: "events", mode: "nested_records" };
    const flatBinding: BigQueryBinding = { dataset: "analytics", table: "events", mode: "columns" };
    const rawBinding: BigQueryBinding = { dataset: "analytics", table: "events", mode: "json_column" };

    expect(bigQueryModeForBinding()).toBe("typed_records");
    expect(bigQueryModeForBinding(null)).toBe("typed_records");
    expect(bigQueryModeForBinding(typedBinding)).toBe("typed_records");
    expect(bigQueryModeForBinding(nestedBinding)).toBe("nested_records");
    expect(bigQueryModeForBinding(flatBinding)).toBe("columns");
    expect(bigQueryModeForBinding(rawBinding)).toBe("json_column");
    expect(bigQueryModeForBinding({ table: "legacy-without-mode" })).toBe("json_column");
    expect(bigQueryModeForBinding({ table: "legacy", mode: "unknown" })).toBe("json_column");
  });

  it("requires a fresh table when an existing binding switches to nested_records", () => {
    expect(
      prepareBigQueryBindingForEdit(
        { dataset: "analytics", table: "events", mode: "nested_records" },
        { dataset: "analytics", table: "events", mode: "columns" },
      ),
    ).toEqual({ error: "nested_requires_new_table" });
    expect(
      prepareBigQueryBindingForEdit(
        { dataset: "analytics", table: "events_nested", mode: "nested_records" },
        { dataset: "analytics", table: "events", mode: "columns" },
      ),
    ).toEqual({ binding: { dataset: "analytics", table: "events_nested", mode: "nested_records" } });
    expect(
      prepareBigQueryBindingForEdit(
        { dataset: "analytics", table: " events ", mode: "nested_records" },
        { dataset: "analytics", table: "events", mode: "columns" },
      ),
    ).toEqual({ error: "nested_requires_new_table" });
  });

  it("treats dataset + table as the physical target for nested-mode safety", () => {
    expect(
      prepareBigQueryBindingForEdit(
        { dataset: "analytics", table: "events", mode: "nested_records" },
        { dataset: "marketing", table: "events", mode: "columns" },
      ),
    ).toEqual({
      binding: { dataset: "analytics", table: "events", mode: "nested_records" },
    });
    expect(
      prepareBigQueryBindingForEdit(
        { dataset: "marketing", table: "events", mode: "nested_records" },
        { dataset: "marketing", table: "events", mode: "columns" },
      ),
    ).toEqual({ error: "nested_requires_new_table" });
  });

  it("normalizes and validates BigQuery table names before saving", () => {
    expect(normalizeBigQueryTableName(" data-temp ")).toBe("data-temp");
    expect(normalizeBigQueryTableName("data.temp")).toBeNull();
    expect(normalizeBigQueryTableName("   ")).toBeNull();
    expect(normalizeBigQueryTableName("a".repeat(1024))).toHaveLength(1024);
    expect(normalizeBigQueryTableName("a".repeat(1025))).toBeNull();
    expect(prepareBigQueryBindingForCreate({ dataset: "analytics", table: " events ", mode: "columns" })).toEqual({
      binding: { dataset: "analytics", table: "events", mode: "columns" },
    });
    expect(prepareBigQueryBindingForCreate({ table: "bad table", mode: "columns" })).toEqual({
      error: "invalid_bigquery_table",
    });
  });

  it("normalizes and snapshots qualified BigQuery targets", () => {
    expect(normalizeBigQueryDatasetName(" analytics ")).toBe("analytics");
    expect(normalizeBigQueryDatasetName("bad-dataset")).toBeNull();
    expect(normalizeBigQueryTarget(" analytics.data-temp ")).toEqual({
      dataset: "analytics",
      table: "data-temp",
    });
    expect(normalizeBigQueryTarget("too.many.parts")).toBeNull();
    expect(formatBigQueryTarget({ dataset: "analytics", table: "events" })).toBe(
      "analytics.events",
    );

    expect(
      prepareBigQueryBindingForCreate({ table: "analytics.events", mode: "columns" }),
    ).toEqual({
      binding: { dataset: "analytics", table: "events", mode: "columns" },
    });
  });

  it("rejects invalid, conflicting, or unresolved BigQuery datasets", () => {
    expect(
      prepareBigQueryBindingForCreate({ dataset: "bad-dataset", table: "events" }),
    ).toEqual({ error: "invalid_bigquery_dataset" });
    expect(
      prepareBigQueryBindingForCreate({ dataset: "one", table: "two.events" }),
    ).toEqual({ error: "invalid_bigquery_dataset" });
    expect(
      prepareBigQueryBindingForCreate({ table: "events" }),
    ).toEqual({ error: "missing_bigquery_dataset" });
  });

  it("preserves rollback metadata only while the migrated binding stays unchanged", () => {
    const metadata = {
      version: 1,
      target_table: "events_nested",
      previous_binding: { dataset: "analytics", table: "events", mode: "columns" },
    };
    const previous = {
      dataset: "analytics",
      table: "events_nested",
      mode: "nested_records",
      _axel_nested_records_migration: metadata,
    };
    expect(
      prepareBigQueryBindingForEdit(
        {
          dataset: "analytics",
          table: "events_nested",
          mode: "nested_records",
          _axel_nested_records_migration: { tampered: true },
        },
        previous,
      ),
    ).toEqual({ binding: previous });
    expect(
      prepareBigQueryBindingForEdit(
        {
          dataset: "analytics",
          table: "events_v2",
          mode: "nested_records",
          _axel_nested_records_migration: { tampered: true },
        },
        previous,
      ),
    ).toEqual({ binding: { dataset: "analytics", table: "events_v2", mode: "nested_records" } });
    expect(
      prepareBigQueryBindingForEdit(
        {
          dataset: "analytics",
          table: "events_nested",
          mode: "columns",
          _axel_nested_records_migration: { tampered: true },
        },
        previous,
      ),
    ).toEqual({ binding: { dataset: "analytics", table: "events_nested", mode: "columns" } });

    const datasetPrevious = {
      dataset: "marketing",
      table: "events_nested",
      mode: "nested_records",
      _axel_nested_records_migration: metadata,
    };
    expect(
      prepareBigQueryBindingForEdit(
        { dataset: "analytics", table: "events_nested", mode: "nested_records" },
        datasetPrevious,
      ),
    ).toEqual({
      binding: {
        dataset: "analytics",
        table: "events_nested",
        mode: "nested_records",
      },
    });
  });

  it("shapes object-store bindings (binding.key_prefix)", () => {
    expect(pipelineBindingForNewDestination("s3", "axel/")).toEqual({ key_prefix: "axel/" });
    expect(pipelineBindingForNewDestination("r2", "axel/")).toEqual({ key_prefix: "axel/" });
  });

  it("returns null for URL-shaped destinations that need no binding", () => {
    expect(pipelineBindingForNewDestination("webhook", "x")).toBeNull();
    expect(pipelineBindingForNewDestination("http", "x")).toBeNull();
  });

  it("returns null for an empty/whitespace target so a missing table can be caught", () => {
    expect(pipelineBindingForNewDestination("postgres", "")).toBeNull();
    expect(pipelineBindingForNewDestination("postgres", "   ")).toBeNull();
  });

  it("trims the target name", () => {
    expect(pipelineBindingForNewDestination("postgres", "  events  ")).toEqual({
      table: "events",
      mode: "dotted_columns",
    });
  });

  it("marks exactly the table-shaped types as binding-required", () => {
    expect([...PIPELINE_BINDING_REQUIRED].sort()).toEqual([
      "bigquery",
      "databricks_sql",
      "databricks_volume",
      "mongodb",
      "postgres",
    ]);
    expect(PIPELINE_BINDING_REQUIRED.has("webhook")).toBe(false);
    expect(PIPELINE_BINDING_REQUIRED.has("s3")).toBe(false);
  });
});
