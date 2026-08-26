import assert from "node:assert/strict";
import {
  assertNestedBindingState,
  planNestedBinding,
  planNestedBindingRollback,
} from "../migrate-bigquery-nested-bindings.mjs";

const migratedAt = "2030-01-15T12:00:00.000Z";
const original = {
  dataset: "demo_newsletter",
  table: "data-temp",
  mode: "columns",
  payload_column: "payload",
  custom_option: true,
};
const plan = planNestedBinding(original, { migratedAt });
assert.equal(plan.action, "migrate");
assert.equal(plan.previousTable, "data-temp");
assert.equal(plan.targetTable, "data-temp_nested");
assert.deepEqual(plan.binding, {
  dataset: "demo_newsletter",
  table: "data-temp_nested",
  mode: "nested_records",
  payload_column: "payload",
  custom_option: true,
  _axel_nested_records_migration: {
    version: 1,
    previous_table: "data-temp",
    previous_mode: "columns",
    previous_binding: original,
    target_table: "data-temp_nested",
    migrated_at: migratedAt,
  },
});
assert.deepEqual(original, {
  dataset: "demo_newsletter",
  table: "data-temp",
  mode: "columns",
  payload_column: "payload",
  custom_option: true,
});

const rollback = planNestedBindingRollback(plan.binding);
assert.equal(rollback.action, "rollback");
assert.deepEqual(rollback.binding, original);

const legacyWithoutOptIn = planNestedBinding(
  { table: "events" },
  { suffix: "-records", migratedAt },
);
assert.equal(legacyWithoutOptIn.action, "skip");

const legacy = planNestedBinding(
  { table: "events" },
  { suffix: "-records", migratedAt, includeJsonColumn: true },
);
assert.equal(legacy.action, "migrate");
assert.equal(legacy.targetTable, "events-records");
const legacyRollback = planNestedBindingRollback(legacy.binding);
assert.deepEqual(legacyRollback.binding, { table: "events" });

const fallback = planNestedBinding(
  { table: "legacy-config", mode: "json_column" },
  { migratedAt, previousBinding: null, includeJsonColumn: true },
);
assert.equal(fallback.action, "migrate");
assert.equal(fallback.targetTable, "legacy-config_nested");
assert.equal(planNestedBindingRollback(fallback.binding).binding, null);

const alreadySuffixed = planNestedBinding(
  { table: "events_nested", mode: "columns" },
  { migratedAt },
);
assert.equal(alreadySuffixed.targetTable, "events_nested_nested");

assert.equal(planNestedBinding(plan.binding).action, "skip");
assert.match(
  planNestedBinding({
    table: "events_nested",
    mode: "nested_records",
    _axel_nested_records_migration: { version: 1, target_table: "different_table" },
  }).reason,
  /invalid nested_records binding/,
);
assert.equal(planNestedBinding({ table: "events", mode: "future_mode" }, { includeJsonColumn: true }).action, "skip");
assert.equal(planNestedBinding({ mode: "columns" }).action, "skip");
assert.equal(planNestedBindingRollback(original).action, "skip");
assert.equal(
  planNestedBindingRollback({ ...plan.binding, table: "operator_changed_table" }).reason,
  "binding changed after nested migration",
);
assert.equal(
  planNestedBindingRollback({
    ...plan.binding,
    _axel_nested_records_migration: {
      ...plan.binding._axel_nested_records_migration,
      version: 2,
    },
  }).reason,
  "unsupported migration version 2",
);
assert.throws(() => planNestedBinding(original, { suffix: ".nested" }), /invalid suffix/);

assert.deepEqual(assertNestedBindingState(plan.binding, "applied"), { ok: true });
assert.deepEqual(
  assertNestedBindingState({ table: "already_nested", mode: "nested_records" }, "applied"),
  { ok: true },
);
assert.deepEqual(assertNestedBindingState({ table: "raw", mode: "json_column" }, "applied"), {
  ok: true,
});
assert.equal(assertNestedBindingState(original, "applied").ok, false);
assert.equal(
  assertNestedBindingState(
    {
      ...plan.binding,
      table: "changed",
    },
    "applied",
  ).ok,
  false,
);
assert.deepEqual(assertNestedBindingState(original, "rolled-back"), { ok: true });
assert.deepEqual(assertNestedBindingState(null, "rolled-back"), { ok: true });
assert.equal(assertNestedBindingState(plan.binding, "rolled-back").ok, false);

console.log("BigQuery nested binding migration tests passed");
