#!/usr/bin/env node
/**
 * Backfill ClickHouse `events.event_type` for rows ingested before the column
 * existed.
 *
 * Every NEW event self-populates the column (the ingest + pull workers stamp
 * it via @axel/shared `extractEventTypeFromBody`), but historical rows carry
 * the `''` default. Data Contract inference now enumerates event types with a
 * `GROUP BY event_type`, so un-backfilled rows are invisible to it — this
 * one-shot reads each untyped event's payload from R2, extracts the type with
 * the SAME canonical helper the workers use (zero formula drift), and writes
 * it back via a small number of grouped `ALTER TABLE ... UPDATE` mutations.
 *
 * Idempotent + re-runnable: only ever touches rows where `event_type = ''`,
 * cursors forward by event_id, and the UPDATE re-asserts `event_type = ''` in
 * its WHERE so a concurrent ingest can't be clobbered.
 *
 * Usage (after `pnpm --filter @axel/shared build`):
 *   CLICKHOUSE_URL=... CLICKHOUSE_USER=... CLICKHOUSE_PASSWORD=... \
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
 *   node scripts/backfill-event-type.mjs \
 *     [--workspace ws_...] [--source src_...] \
 *     [--batch 2000] [--concurrency 32] [--bucket axel-events-raw] [--dry-run]
 *
 * Scope to one source first (--source) to validate, then widen.
 */
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function fail(msg) {
  console.error(`[backfill-event-type] ${msg}`);
  process.exit(1);
}
function log(msg) {
  console.log(`[backfill-event-type] ${msg}`);
}

const { values } = parseArgs({
  options: {
    workspace: { type: "string" },
    source: { type: "string" },
    batch: { type: "string", default: "2000" },
    concurrency: { type: "string", default: "32" },
    bucket: { type: "string", default: "axel-events-raw" },
    "dry-run": { type: "boolean", default: false },
  },
});
const BATCH = Math.max(1, Number(values.batch) || 2000);
const CONCURRENCY = Math.max(1, Number(values.concurrency) || 32);
const BUCKET = values.bucket;
const DRY_RUN = values["dry-run"] === true;

const CH_URL = process.env.CLICKHOUSE_URL;
const CH_USER = process.env.CLICKHOUSE_USER ?? "default";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD ?? "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!CH_URL) fail("CLICKHOUSE_URL must be set");
if (!CF_TOKEN || !CF_ACCOUNT) fail("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set (R2 reads)");

// Canonical extractor from the BUILT shared package — identical to the workers.
const sharedDist = path.join(REPO_ROOT, "packages/shared/dist/index.js");
let extractEventTypeFromBody;
try {
  ({ extractEventTypeFromBody } = await import(pathToFileURL(sharedDist).href));
} catch {
  fail("could not import packages/shared/dist — run `pnpm --filter @axel/shared build` first");
}
if (typeof extractEventTypeFromBody !== "function") {
  fail("extractEventTypeFromBody not exported from @axel/shared");
}

// `createRequire` kept for parity with sibling scripts; no native deps needed.
void createRequire;

function chEscape(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function chQuery(sql, { json = true } = {}) {
  const url = new URL(CH_URL);
  if (json) url.searchParams.set("default_format", "JSON");
  const res = await fetch(url, {
    method: "POST",
    body: sql,
    headers: {
      "content-type": "text/plain; charset=UTF-8",
      "x-clickhouse-user": CH_USER,
      ...(CH_PASSWORD ? { "x-clickhouse-key": CH_PASSWORD } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ClickHouse ${res.status}: ${body.slice(0, 400)}`);
  }
  const text = await res.text();
  if (!json) return text;
  return text.trim() ? JSON.parse(text) : { data: [] };
}

// ClickHouse ALTER...UPDATE mutations run async server-side. Firing them in a
// tight loop with no backpressure piles up hundreds of pending mutations, which
// stresses the merge scheduler and can starve the cluster. Before issuing the
// next mutation, wait until the number of UNFINISHED mutations on `events`
// drops to a small threshold. The script stays resumable: it only ever touches
// rows where event_type = '' and cursors by event_id, so a kill mid-wait just
// resumes from the last cursor on the next run.
const MAX_PENDING_MUTATIONS = 2;
const MUTATION_POLL_INTERVAL_MS = 2000;
// Ceiling on one backpressure wait. A healthy cluster drains a mutation in
// seconds-to-minutes; a wait this long means a mutation is genuinely stuck
// (blocked merge, replication issue) and polling forever just hides the
// problem from the operator. Failing is safe: the script is resumable, so
// after the stuck mutation is inspected/killed a re-run picks up where the
// cursor left off.
const MAX_MUTATION_WAIT_MS = 15 * 60 * 1000;
// Progress-log cadence while waiting, so a long (but healthy) drain is
// visible instead of looking like a hang.
const MUTATION_WAIT_LOG_EVERY_MS = 30 * 1000;

async function pendingMutationCount(table) {
  // is_done covers normal completion; is_killed excludes ones an operator
  // cancelled so we don't wait forever on a stuck/killed mutation.
  const res = await chQuery(
    `SELECT count() AS n FROM system.mutations ` +
      `WHERE table = '${chEscape(table)}' AND is_done = 0 AND is_killed = 0`,
  );
  return Number(res.data?.[0]?.n ?? 0);
}

async function waitForMutationBackpressure(table) {
  const startedAt = Date.now();
  let lastLoggedAt = startedAt;
  for (;;) {
    let pending;
    try {
      pending = await pendingMutationCount(table);
    } catch {
      // If we can't read system.mutations (perms, transient), don't deadlock —
      // proceed without backpressure rather than stall the whole backfill.
      return;
    }
    if (pending <= MAX_PENDING_MUTATIONS) return;
    const waitedMs = Date.now() - startedAt;
    if (waitedMs >= MAX_MUTATION_WAIT_MS) {
      // Escalate instead of polling forever on a stuck mutation. fail() exits
      // non-zero so cron/CI wrappers alert; the cursor design makes a re-run
      // after operator intervention safe (only event_type='' rows are touched).
      fail(
        `gave up waiting for mutation backpressure on '${table}': ` +
          `${pending} pending mutations still > ${MAX_PENDING_MUTATIONS} after ` +
          `${Math.round(MAX_MUTATION_WAIT_MS / 60000)} minutes — a mutation looks stuck. ` +
          `Inspect with: SELECT mutation_id, command, latest_fail_reason FROM system.mutations ` +
          `WHERE table = '${table}' AND is_done = 0; kill the stuck one with ` +
          `KILL MUTATION WHERE mutation_id = '<id>', then re-run this script to resume.`,
      );
    }
    if (Date.now() - lastLoggedAt >= MUTATION_WAIT_LOG_EVERY_MS) {
      lastLoggedAt = Date.now();
      log(
        `waiting on mutation backpressure: ${pending} pending on '${table}' ` +
          `(threshold ${MAX_PENDING_MUTATIONS}, waited ${Math.round(waitedMs / 1000)}s ` +
          `of max ${Math.round(MAX_MUTATION_WAIT_MS / 60000)}m)`,
      );
    }
    await new Promise((r) => setTimeout(r, MUTATION_POLL_INTERVAL_MS));
  }
}

async function fetchR2(r2Key) {
  const encodedKey = r2Key.split("/").map((segment) => {
    if (segment === "." || segment === "..") {
      throw new Error("invalid_r2_object_key: dot path segments are not supported");
    }
    return encodeURIComponent(segment);
  }).join("/");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT)}/r2/buckets/${encodeURIComponent(BUCKET)}/objects/${encodedKey}`;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${CF_TOKEN}` } });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Run an async mapper over items with a fixed concurrency ceiling.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const scope = [
  values.workspace ? `AND workspace_id = '${chEscape(values.workspace)}'` : "",
  values.source ? `AND source_id = '${chEscape(values.source)}'` : "",
].join(" ");

// Total remaining, for progress.
const totalRes = await chQuery(
  `SELECT count() AS n FROM events WHERE event_type = '' ${scope}`,
);
const totalRemaining = Number(totalRes.data?.[0]?.n ?? 0);
log(
  `${totalRemaining.toLocaleString()} untyped events in scope` +
    `${values.source ? ` (source ${values.source})` : ""}` +
    `${DRY_RUN ? " — DRY RUN" : ""}`,
);
if (totalRemaining === 0) {
  log("nothing to backfill.");
  process.exit(0);
}

let cursor = "";
let scanned = 0;
let typed = 0;
let untypable = 0;
let unfetchable = 0;
let updatedRows = 0;
let mutations = 0;

for (;;) {
  const page = await chQuery(
    `SELECT event_id, r2_key, headers_json
       FROM events
      WHERE event_type = '' ${scope}
        AND event_id > '${chEscape(cursor)}'
      ORDER BY event_id
      LIMIT ${BATCH}`,
  );
  const rows = page.data ?? [];
  if (rows.length === 0) break;

  const extracted = await mapPool(rows, CONCURRENCY, async (row) => {
    const bytes = await fetchR2(row.r2_key);
    if (bytes === null) return { event_id: row.event_id, type: null, fetched: false };
    // Same body-then-headers logic the workers use, so backfilled rows match
    // newly-ingested ones exactly.
    let headers;
    try {
      headers = JSON.parse(row.headers_json || "{}");
    } catch {
      headers = {};
    }
    return { event_id: row.event_id, type: extractEventTypeFromBody(bytes, headers), fetched: true };
  });

  // Group event_ids by extracted type so one mutation covers many rows.
  const byType = new Map();
  for (const e of extracted) {
    scanned++;
    if (!e.fetched) {
      unfetchable++;
      continue;
    }
    if (!e.type) {
      untypable++;
      continue;
    }
    typed++;
    if (!byType.has(e.type)) byType.set(e.type, []);
    byType.get(e.type).push(e.event_id);
  }

  for (const [type, ids] of byType) {
    // Chunk the IN list so a single mutation statement stays a sane size.
    for (let k = 0; k < ids.length; k += 5000) {
      const chunk = ids.slice(k, k + 5000);
      const inList = chunk.map((id) => `'${chEscape(id)}'`).join(",");
      const sql =
        `ALTER TABLE events UPDATE event_type = '${chEscape(type)}' ` +
        `WHERE event_type = '' AND event_id IN (${inList})`;
      if (!DRY_RUN) {
        // Bounded backpressure: don't issue the next mutation until pending
        // ones on `events` drain below the threshold.
        await waitForMutationBackpressure("events");
        await chQuery(sql, { json: false });
        mutations++;
      }
      updatedRows += chunk.length;
    }
  }

  cursor = rows[rows.length - 1].event_id;
  log(
    `scanned ${scanned.toLocaleString()} | typed ${typed.toLocaleString()} | ` +
      `untypable ${untypable.toLocaleString()} | unfetchable ${unfetchable.toLocaleString()} | ` +
      `${DRY_RUN ? "would update" : "updating"} ${updatedRows.toLocaleString()} rows in ${mutations} mutations`,
  );
}

log("");
log(
  `DONE. scanned=${scanned} typed=${typed} untypable=${untypable} ` +
    `unfetchable=${unfetchable} ${DRY_RUN ? "would-update" : "updated"}=${updatedRows} mutations=${mutations}`,
);
if (!DRY_RUN) {
  log(
    "ClickHouse mutations are async — track with: " +
      "SELECT * FROM system.mutations WHERE table='events' AND is_done=0",
  );
}
