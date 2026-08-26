#!/usr/bin/env node
/**
 * Cut existing BigQuery route bindings over to `nested_records` without
 * overwriting their current flat/raw tables.
 *
 * The migration writes new events to a suffixed table and records enough
 * metadata inside the JSONB binding to roll back atomically. The destination
 * connector creates the new table from the first nested event, so this script
 * never needs customer BigQuery credentials.
 *
 * Usage:
 *   node scripts/migrate-bigquery-nested-bindings.mjs
 *   node scripts/migrate-bigquery-nested-bindings.mjs --apply
 *   node scripts/migrate-bigquery-nested-bindings.mjs --apply --rollback
 *   node scripts/migrate-bigquery-nested-bindings.mjs --destination dst_...
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv, loadLocalEnv } from "./load-env.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_KEY = "_axel_nested_records_migration";
const MIGRATION_VERSION = 1;
const DEFAULT_SUFFIX = "_nested";
const VALID_TABLE = /^[A-Za-z0-9_-]+$/;

function fail(message) {
  throw new Error(`[migrate-bq-nested] ${message}`);
}

function normalizedSuffix(value) {
  const suffix = value || DEFAULT_SUFFIX;
  if (!/^[A-Za-z0-9_-]+$/.test(suffix)) {
    fail(`invalid suffix ${JSON.stringify(suffix)}`);
  }
  return suffix;
}

export function planNestedBinding(binding, options = {}) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { action: "skip", reason: "binding is not an object" };
  }
  const table = typeof binding.table === "string" ? binding.table.trim() : "";
  if (!table) return { action: "skip", reason: "binding has no table" };
  if (!VALID_TABLE.test(table)) return { action: "skip", reason: `invalid table ${table}` };
  if (binding.mode === "nested_records") {
    const assertion = assertNestedBindingState(binding, "applied");
    if (!assertion.ok) {
      return { action: "skip", reason: `invalid nested_records binding: ${assertion.reason}` };
    }
    return { action: "skip", reason: "already nested_records" };
  }
  const currentMode = typeof binding.mode === "string" ? binding.mode : "json_column";
  if (currentMode !== "columns" && currentMode !== "json_column") {
    return { action: "skip", reason: `unsupported mode ${currentMode}` };
  }
  if (currentMode === "json_column" && options.includeJsonColumn !== true) {
    return {
      action: "skip",
      reason: `${currentMode} requires an explicit include-json-column opt-in`,
    };
  }

  const suffix = normalizedSuffix(options.suffix);
  // Always append. Reusing a source table that merely happens to end with the
  // suffix would violate the migration's preserve-the-old-table guarantee.
  const targetTable = `${table}${suffix}`;
  if (targetTable.length > 1024) {
    return { action: "skip", reason: "suffixed table name exceeds 1024 characters" };
  }
  const migratedAt = options.migratedAt ?? new Date().toISOString();
  const previousBinding = Object.hasOwn(options, "previousBinding")
    ? options.previousBinding
    : binding;
  return {
    action: "migrate",
    previousTable: table,
    targetTable,
    binding: {
      ...binding,
      table: targetTable,
      mode: "nested_records",
      [MIGRATION_KEY]: {
        version: MIGRATION_VERSION,
        previous_table: table,
        previous_mode: typeof binding.mode === "string" ? binding.mode : null,
        previous_binding: previousBinding,
        target_table: targetTable,
        migrated_at: migratedAt,
      },
    },
  };
}

export function planNestedBindingRollback(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { action: "skip", reason: "binding is not an object" };
  }
  const metadata = binding[MIGRATION_KEY];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { action: "skip", reason: "no nested migration metadata" };
  }
  if (metadata.version !== MIGRATION_VERSION) {
    return { action: "skip", reason: `unsupported migration version ${String(metadata.version)}` };
  }
  if (
    binding.mode !== "nested_records" ||
    typeof metadata.target_table !== "string" ||
    binding.table !== metadata.target_table
  ) {
    return { action: "skip", reason: "binding changed after nested migration" };
  }
  const previousTable =
    typeof metadata.previous_table === "string" ? metadata.previous_table.trim() : "";
  if (!previousTable || !VALID_TABLE.test(previousTable)) {
    return { action: "skip", reason: "migration metadata has no valid previous table" };
  }

  let restored;
  if (Object.hasOwn(metadata, "previous_binding")) {
    restored = metadata.previous_binding;
  } else return { action: "skip", reason: "migration metadata has no previous binding" };
  return {
    action: "rollback",
    previousTable: binding.table,
    targetTable: previousTable,
    binding: restored,
  };
}

/** Pure read-back assertion used after a production workflow mutation. */
export function assertNestedBindingState(binding, state) {
  if (state === "rolled-back") {
    if (
      binding &&
      typeof binding === "object" &&
      !Array.isArray(binding) &&
      Object.hasOwn(binding, MIGRATION_KEY)
    ) {
      return { ok: false, reason: "nested migration metadata is still present" };
    }
    return { ok: true };
  }

  if (state !== "applied") return { ok: false, reason: `unsupported assertion state ${state}` };
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    return { ok: false, reason: "binding is not an object" };
  }
  const mode = typeof binding.mode === "string" ? binding.mode : "json_column";
  if (mode === "json_column" && !Object.hasOwn(binding, MIGRATION_KEY)) {
    // Raw JSON bindings are deliberately outside the default bulk cutover.
    return { ok: true };
  }
  if (binding.mode !== "nested_records") {
    return { ok: false, reason: `binding mode is ${mode}` };
  }
  const metadata = binding[MIGRATION_KEY];
  // A route that was already nested before this migration legitimately has no
  // migration metadata. If metadata is present, validate it strictly.
  if (metadata === undefined) return { ok: true };
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return { ok: false, reason: "nested migration metadata is malformed" };
  }
  if (metadata.version !== MIGRATION_VERSION) {
    return { ok: false, reason: `unsupported migration version ${String(metadata.version)}` };
  }
  if (typeof metadata.target_table !== "string" || binding.table !== metadata.target_table) {
    return { ok: false, reason: "binding table does not match migration target" };
  }
  return { ok: true };
}

async function main() {
  loadLocalEnv();
  loadDotEnv("apps/dashboard/.env.local");

  const { values } = parseArgs({
    options: {
      apply: { type: "boolean", default: false },
      rollback: { type: "boolean", default: false },
      destination: { type: "string" },
      suffix: { type: "string", default: DEFAULT_SUFFIX },
      "include-json-column": { type: "boolean", default: false },
      "assert-state": { type: "string" },
    },
  });
  if (values["assert-state"] && (values.apply || values.rollback)) {
    fail("--assert-state cannot be combined with --apply or --rollback");
  }
  if (
    values["assert-state"] &&
    values["assert-state"] !== "applied" &&
    values["assert-state"] !== "rolled-back"
  ) {
    fail("--assert-state must be applied or rolled-back");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail("DATABASE_URL must be set");

  const require = createRequire(path.join(REPO_ROOT, "apps/dashboard/package.json"));
  const { Client } = require("pg");
  const client = new Client({
    connectionString: databaseUrl,
    ssl: databaseUrl.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  await client.connect();

  const plans = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('axel:migrate-bigquery-nested-bindings'))");
    const result = await client.query(
      `SELECT rd.route_id,
              rd.destination_id,
              rd.binding,
              d.name AS destination_name,
              d.status AS destination_status,
              r.status AS route_status,
              d.config->>'project_id' AS project_id,
              COALESCE(NULLIF(rd.binding->>'dataset', ''), d.config->>'dataset') AS dataset,
              d.config
         FROM route_destinations rd
         JOIN destinations d ON d.id = rd.destination_id
         JOIN routes r ON r.id = rd.route_id
        WHERE d.type = 'bigquery'
          AND ($1::text IS NULL OR d.id = $1)
        ORDER BY rd.destination_id, rd.route_id
        FOR UPDATE OF rd`,
      [values.destination ?? null],
    );

    if (values.destination && result.rowCount === 0) {
      fail(`destination ${values.destination} has no BigQuery route bindings`);
    }

    if (values["assert-state"]) {
      const failures = [];
      for (const row of result.rows) {
        const effectiveBinding = row.binding ?? (
          typeof row.config?.table === "string" && row.config.table
            ? {
                table: row.config.table,
                mode: "json_column",
                ...(typeof row.config.payload_column === "string"
                  ? { payload_column: row.config.payload_column }
                  : {}),
              }
            : row.binding
        );
        const assertion = assertNestedBindingState(effectiveBinding, values["assert-state"]);
        if (!assertion.ok) {
          failures.push(`${row.destination_id}/${row.route_id}: ${assertion.reason}`);
        }
      }
      if (failures.length > 0) {
        fail(`state assertion failed for ${failures.length} binding(s): ${failures.join("; ")}`);
      }
      await client.query("ROLLBACK");
      console.log(
        `[migrate-bq-nested] verified ${values["assert-state"]} state for ${result.rowCount} binding(s)`,
      );
      return;
    }

    const migratedAt = new Date().toISOString();
    for (const row of result.rows) {
      const effectiveBinding = row.binding ?? (
        typeof row.config?.table === "string" && row.config.table
          ? {
              table: row.config.table,
              mode: "json_column",
              ...(typeof row.config.payload_column === "string"
                ? { payload_column: row.config.payload_column }
                : {}),
            }
          : row.binding
      );
      const plan = values.rollback
        ? planNestedBindingRollback(row.binding)
        : planNestedBinding(effectiveBinding, {
            suffix: values.suffix,
            migratedAt,
            previousBinding: row.binding,
            includeJsonColumn: values["include-json-column"],
          });
      plans.push({ row, plan });
      const scope = `${row.project_id}.${row.dataset}`;
      if (plan.action === "skip") {
        console.log(
          `[migrate-bq-nested] skip ${row.destination_id}/${row.route_id} (${scope}): ${plan.reason}`,
        );
        continue;
      }
      console.log(
        `[migrate-bq-nested] ${values.apply ? "apply" : "plan"} ${plan.action} ` +
          `${row.destination_id}/${row.route_id}: ${plan.previousTable} -> ${plan.targetTable}`,
      );
      if (!values.apply) continue;

      const update = await client.query(
        `UPDATE route_destinations
            SET binding = $3::jsonb
          WHERE route_id = $1
            AND destination_id = $2
            AND binding IS NOT DISTINCT FROM $4::jsonb
          RETURNING binding IS NOT DISTINCT FROM $3::jsonb AS matches`,
        [
          row.route_id,
          row.destination_id,
          plan.binding === null ? null : JSON.stringify(plan.binding),
          row.binding === null ? null : JSON.stringify(row.binding),
        ],
      );
      if (update.rowCount !== 1 || update.rows[0]?.matches !== true) {
        fail(`concurrent binding change detected for ${row.destination_id}/${row.route_id}`);
      }
    }

    const actionable = plans.filter(({ plan }) => plan.action !== "skip").length;
    const blockingSkips = plans.filter(({ plan }) => {
      if (plan.action !== "skip") return false;
      if (!values.rollback && plan.reason === "already nested_records") return false;
      if (
        !values.rollback &&
        plan.reason === "json_column requires an explicit include-json-column opt-in"
      ) return false;
      if (values.rollback && plan.reason === "no nested migration metadata") return false;
      return true;
    });
    if (values.apply && blockingSkips.length > 0) {
      fail(`${blockingSkips.length} BigQuery binding(s) could not be planned; no changes committed`);
    }
    if (values.apply) {
      await client.query("COMMIT");
      console.log(`[migrate-bq-nested] committed ${actionable} binding change(s)`);
    } else {
      await client.query("ROLLBACK");
      console.log(`[migrate-bq-nested] dry run: ${actionable} binding change(s) planned`);
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
