#!/usr/bin/env node
/**
 * Backfill dead_letters.fingerprint for rows written before migration 0053.
 *
 * The column self-populates for every NEW dead letter (the writers stamp it),
 * but historical rows are NULL — and a NULL fingerprint never matches a mute,
 * so a "replay all unresolved" run could re-replay failures the operator had
 * muted, until those rows are backfilled. This one-shot fills them.
 *
 * It reuses the canonical @axel/shared `deadLetterFingerprint` (built dist) so
 * there is ZERO chance of formula drift vs. the writers / the inbox. Idempotent
 * and re-runnable: it only ever touches rows where fingerprint IS NULL, in
 * id-ordered batches, and stops when none remain.
 *
 * Usage (after `pnpm --filter @axel/shared build`):
 *   DATABASE_URL=postgres://... node scripts/backfill-dead-letter-fingerprints.mjs [--batch 1000] [--dry-run]
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { controlPlanePgSslOption } from "./control-plane-pg.mjs";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function fail(msg) {
  console.error(`[backfill-dl-fp] ${msg}`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    batch: { type: "string", default: "1000" },
    "dry-run": { type: "boolean", default: false },
  },
});
const BATCH = Math.max(1, Number(values.batch) || 1000);
const DRY_RUN = values["dry-run"] === true;

if (!process.env.DATABASE_URL) fail("DATABASE_URL must be set");

// Resolve `pg` from the dashboard workspace (it's a direct dependency there);
// this script lives at the repo root where pg may not be hoisted.
const require = createRequire(path.join(REPO_ROOT, "apps/dashboard/package.json"));
let Pool;
try {
  ({ Pool } = require("pg"));
} catch {
  fail("could not resolve 'pg' — run from the repo root after `pnpm install`");
}

// The canonical fingerprint formula, from the BUILT shared package.
const sharedDist = path.join(REPO_ROOT, "packages/shared/dist/index.js");
let deadLetterFingerprint;
try {
  ({ deadLetterFingerprint } = await import(pathToFileURL(sharedDist).href));
} catch {
  fail("could not import packages/shared/dist — run `pnpm --filter @axel/shared build` first");
}
if (typeof deadLetterFingerprint !== "function") fail("deadLetterFingerprint not exported from @axel/shared");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: controlPlanePgSslOption(
    process.env.DATABASE_URL,
    process.env.CONTROL_PLANE_DB_SSL_VERIFY,
  ),
});

let scanned = 0;
let updated = 0;
try {
  for (;;) {
    const { rows } = await pool.query(
      `SELECT id, route_id, reason, message
         FROM dead_letters
        WHERE fingerprint IS NULL
        ORDER BY id
        LIMIT $1`,
      [BATCH],
    );
    if (rows.length === 0) break;
    scanned += rows.length;

    for (const row of rows) {
      const fp = await deadLetterFingerprint({
        route_id: row.route_id ?? "",
        reason: row.reason,
        message: row.message,
      });
      if (DRY_RUN) {
        updated += 1;
        continue;
      }
      // Guard on fingerprint IS NULL so a concurrent writer that already
      // stamped the row isn't clobbered.
      const res = await pool.query(
        `UPDATE dead_letters SET fingerprint = $2 WHERE id = $1 AND fingerprint IS NULL`,
        [row.id, fp],
      );
      updated += res.rowCount ?? 0;
    }
    console.log(`[backfill-dl-fp] scanned ${scanned}, ${DRY_RUN ? "would update" : "updated"} ${updated}…`);

    // In dry-run we never write, so the WHERE-NULL set never shrinks — stop
    // after the first page rather than loop forever.
    if (DRY_RUN) break;
  }
  console.log(`[backfill-dl-fp] done — scanned ${scanned}, ${DRY_RUN ? "would update" : "updated"} ${updated}`);
} finally {
  await pool.end().catch(() => {});
}
