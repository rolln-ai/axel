#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

for (const name of names) {
  const match = name.match(filenamePattern);
  if (!match) {
    failures.push(`${name}: migration names must match NNNN_lower_snake_case.sql`);
    continue;
  }
  const entries = byNumber.get(match[1]) ?? [];
  entries.push(name);
  byNumber.set(match[1], entries);
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

if (failures.length > 0) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}

process.stdout.write(`Postgres migration validation passed for ${names.length} files.\n`);
