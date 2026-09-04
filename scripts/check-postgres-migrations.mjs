#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unsafeMigrationSessionControl } from "./postgres-migration-safety.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(repoRoot, "infra/postgres/migrations");
const schema = readFileSync(join(repoRoot, "infra/postgres/schema.sql"), "utf8");
const names = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
const filenamePattern = /^(\d{4})_[a-z0-9_]+\.sql$/;
const allowedHistoricalCollision = new Set([
  "0025_destinations_strip_route_bound_config.sql",
  "0025_edkg_foundation.sql",
]);
const failures = [];
const byNumber = new Map();
const grandfatheredUnsafeMigrations = new Map([
  [
    "0025_edkg_foundation.sql",
    "5945c09ac118d73c4c202471425d34504e6ddfb0c873a7c304f710a6199ba209",
  ],
]);

for (const name of names) {
  const match = name.match(filenamePattern);
  if (!match) {
    failures.push(`${name}: migration names must match NNNN_lower_snake_case.sql`);
    continue;
  }
  const entries = byNumber.get(match[1]) ?? [];
  entries.push(name);
  byNumber.set(match[1], entries);

  const sql = readFileSync(join(migrationsDir, name), "utf8");
  const contentHash = createHash("sha256").update(sql).digest("hex");
  const knownUnsafeHash = grandfatheredUnsafeMigrations.get(name);
  if (unsafeMigrationSessionControl(sql) && contentHash !== knownUnsafeHash) {
    failures.push(`${name}: migration contains prohibited identity, ownership, role, ACL, or extension SQL`);
  }
}

if (unsafeMigrationSessionControl(schema)) {
  failures.push("schema.sql contains prohibited identity, ownership, role, ACL, or extension SQL");
}

for (const [number, entries] of byNumber) {
  if (entries.length < 2) continue;
  const known0025 = number === "0025"
    && entries.length === allowedHistoricalCollision.size
    && entries.every((name) => allowedHistoricalCollision.has(name));
  if (!known0025) {
    failures.push(`${number}: duplicate migration number used by ${entries.join(", ")}`);
  }
}

// The 0025 collision predates the migration ledger. Keep accepting those two
// immutable filenames, but make any new collision fail before deployment.
for (const name of allowedHistoricalCollision) {
  if (!names.includes(name)) failures.push(`historical migration ${name} is missing`);
}

const deadLetterMigration = readFileSync(
  join(migrationsDir, "0071_dead_letters_is_test.sql"),
  "utf8",
);
if (!/ALTER\s+TABLE\s+dead_letters[\s\S]+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+is_test\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+false/i.test(deadLetterMigration)) {
  failures.push("0071_dead_letters_is_test.sql does not add the expected fail-safe column");
}
if (!/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+dead_letters[\s\S]+?is_test\s+boolean\s+NOT\s+NULL\s+DEFAULT\s+false[\s\S]+?\);/i.test(schema)) {
  failures.push("schema.sql is not in parity with 0071_dead_letters_is_test.sql");
}

const deliveryCanaryMigration = readFileSync(
  join(migrationsDir, "0073_delivery_canary_receipts.sql"),
  "utf8",
);
function hasDeliveryCanaryReceiptSchema(sql) {
  return /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+delivery_canary_receipts/i.test(sql)
    && /payload\s+jsonb\s+NOT\s+NULL/i.test(sql)
    && /received_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s+now\(\)/i.test(sql)
    && /payload\s*\?&\s*ARRAY/i.test(sql)
    && /payload\s*-\s*ARRAY/i.test(sql)
    && /'axel\.delivery_canary'/i.test(sql)
    && /payload\s*->>\s*'axel_canary_probe_id'/i.test(sql)
    && /pg_column_size\(payload\)\s*<=\s*1024/i.test(sql)
    && /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+delivery_canary_receipts_probe_time_idx/i.test(sql)
    && /REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+TABLE\s+delivery_canary_receipts\s+FROM\s+PUBLIC/i.test(sql);
}
if (!hasDeliveryCanaryReceiptSchema(deliveryCanaryMigration)) {
  failures.push("0073_delivery_canary_receipts.sql does not define the constrained receipt table");
}
if (!hasDeliveryCanaryReceiptSchema(schema)) {
  failures.push("schema.sql is not in parity with 0073_delivery_canary_receipts.sql");
}

const billingEventsPayloadMigration = readFileSync(
  join(migrationsDir, "0074_billing_events_payload_minimization.sql"),
  "utf8",
);
function hasBillingEventsPayloadGuard(sql) {
  return /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.axel_minimize_billing_event_payload\s*\(\s*\)\s+RETURNS\s+trigger\s+LANGUAGE\s+plpgsql\s+SECURITY\s+INVOKER\s+AS/i.test(sql)
    && /NEW\.payload\s*:=\s*'\{\}'::pg_catalog\.jsonb\s*;/i.test(sql)
    && /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+public\.axel_minimize_billing_event_payload\s*\(\s*\)\s+FROM\s+PUBLIC\s*;/i.test(sql)
    && /DROP\s+TRIGGER\s+IF\s+EXISTS\s+billing_events_payload_minimization_guard\s+ON\s+public\.billing_events\s*;/i.test(sql)
    && /CREATE\s+TRIGGER\s+billing_events_payload_minimization_guard\s+BEFORE\s+INSERT\s+OR\s+UPDATE\s+OF\s+payload\s+ON\s+public\.billing_events\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+FUNCTION\s+public\.axel_minimize_billing_event_payload\s*\(\s*\)\s*;/i.test(sql)
    && !/axel_minimize_billing_event_payload[\s\S]+?SECURITY\s+DEFINER/i.test(sql);
}
if (
  !/UPDATE\s+public\.billing_events\s+SET\s+payload\s*=\s*'\{\}'::jsonb\s+WHERE\s+payload\s*<>\s*'\{\}'::jsonb\s*;/i.test(billingEventsPayloadMigration)
  || !/ALTER\s+TABLE\s+public\.billing_events\s+ALTER\s+COLUMN\s+payload\s+SET\s+DEFAULT\s+'\{\}'::jsonb\s*;/i.test(billingEventsPayloadMigration)
) {
  failures.push("0074_billing_events_payload_minimization.sql does not selectively scrub payloads and set the empty-object default");
}
if (!hasBillingEventsPayloadGuard(billingEventsPayloadMigration)) {
  failures.push("0074_billing_events_payload_minimization.sql does not install the rolling-writer payload guard");
}
const billingEventsGuardPosition = billingEventsPayloadMigration.search(
  /CREATE\s+TRIGGER\s+billing_events_payload_minimization_guard/i,
);
const billingEventsScrubPosition = billingEventsPayloadMigration.search(
  /UPDATE\s+public\.billing_events\s+SET\s+payload/i,
);
if (
  billingEventsGuardPosition < 0
  || billingEventsScrubPosition < 0
  || billingEventsGuardPosition > billingEventsScrubPosition
) {
  failures.push("0074_billing_events_payload_minimization.sql must install its guard before scrubbing rows");
}
if (/\b(?:ADD\s+CONSTRAINT|CHECK\s*\()/i.test(billingEventsPayloadMigration)) {
  failures.push("0074_billing_events_payload_minimization.sql must not reject rolling old writers");
}
const billingEventsTable = schema.match(
  /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+billing_events\s*\([\s\S]+?\n\);/i,
)?.[0] ?? "";
if (
  !/payload\s+jsonb\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::jsonb/i.test(billingEventsTable)
  || !hasBillingEventsPayloadGuard(schema)
) {
  failures.push("schema.sql is not in parity with 0074_billing_events_payload_minimization.sql");
}

function hasRetentionCapSchema(sql) {
  return /workspaces_raw_payload_retention_days_check[\s\S]+raw_payload_retention_days\s*>=\s*0[\s\S]+raw_payload_retention_days\s*<=\s*30/i.test(sql)
    && /workspaces_dead_letter_retention_days_check[\s\S]+dead_letter_retention_days\s*>=\s*1[\s\S]+dead_letter_retention_days\s*<=\s*365/i.test(sql)
    && /workspaces_replay_request_retention_days_check[\s\S]+replay_request_retention_days\s*>=\s*1[\s\S]+replay_request_retention_days\s*<=\s*90/i.test(sql)
    && /workspaces_audit_log_retention_days_check[\s\S]+audit_log_retention_days\s*>=\s*30[\s\S]+audit_log_retention_days\s*<=\s*3650/i.test(sql)
    && /sources_raw_payload_retention_days_check[\s\S]+raw_payload_retention_days\s+IS\s+NULL[\s\S]+raw_payload_retention_days\s*>=\s*0[\s\S]+raw_payload_retention_days\s*<=\s*30/i.test(sql);
}
if (!hasRetentionCapSchema(schema)) {
  failures.push("schema.sql is not in parity with 0048_retention_caps.sql");
}

if (
  !/CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+erasure_subjects_ws_subject_event_uniq[\s\S]+ON\s+erasure_subjects\s*\(\s*workspace_id\s*,\s*subject_id\s*,\s*event_id\s*\)/i.test(schema)
  || /CREATE\s+(?:UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+erasure_subjects_lookup_idx/i.test(schema)
) {
  failures.push("schema.sql is not in parity with 0054_erasure_subjects_unique.sql");
}

if (!/ALTER\s+TABLE\s+routes\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+name\s+text/i.test(schema)) {
  failures.push("schema.sql is not in parity with 0061_routes_name.sql");
}

for (const [indexName, definition] of [
  ["workspaces_deleting_idx", /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+workspaces_deleting_idx[\s\S]+ON\s+workspaces\s*\(\s*deleted_at\s*\)\s+WHERE\s+status\s*=\s*'deleting'/i],
  ["dead_letters_errored_at_idx", /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+dead_letters_errored_at_idx[\s\S]+ON\s+dead_letters\s*\(\s*errored_at\s*\)/i],
  ["audit_log_at_idx", /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+audit_log_at_idx[\s\S]+ON\s+audit_log\s*\(\s*created_at\s*\)/i],
]) {
  if (!definition.test(schema)) {
    failures.push(`schema.sql is missing ${indexName}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Postgres migration validation passed for ${names.length} files.\n`);
