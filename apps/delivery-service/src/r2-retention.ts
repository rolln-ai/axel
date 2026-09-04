/**
 * AXE-35 follow-up — raw-payload R2 retention sweeper.
 *
 * The per-workspace / per-source `raw_payload_retention_days` setting (and the
 * `transient_mode = 0` shortcut) used to be a no-op on the stored bytes: R2
 * event bodies were deleted only by a fixed, bucket-wide 30-day lifecycle rule
 * (infra/cloudflare/r2-lifecycle.json). This sweeper makes shorter-than-30-day
 * retention actually delete the bytes early.
 *
 * Deliberately bounded scope (see the retention-cap analysis):
 *   - Acts ONLY on sources whose EFFECTIVE raw retention is < 30 days
 *     (effective = source override ?? workspace default). Anything >= 30 is left
 *     to the bucket lifecycle rule, which stays as the ceiling / backstop. So we
 *     only ever delete inside the 0–30 day window.
 *   - ClickHouse is the key source — its `events` table carries
 *     (workspace_id, source_id, received_at, r2_key) and has a 30-day TTL, which
 *     is exactly the window we operate in, so it always has the keys we need.
 *     (R2 keys always embed the workspace but not the source, so we can't get
 *     per-source granularity from an R2 prefix list alone.)
 *   - A MINIMUM-AGE floor (`minAgeMs`, default 7d) protects in-flight delivery:
 *     a delivery still retrying must be able to fetch its body from R2, and a
 *     re-enqueued / flapping delivery can ride the Cloudflare Queue message
 *     retention (default 4d). We never delete younger than the floor, so a value
 *     below it (incl. transient = 0) effectively means "deleted at ~floor days".
 *     The floor MUST exceed the max delivery lifetime; keep it > the queue's
 *     message_retention_period.
 *
 * DI-shaped (inject `lister` + `deleter`) so the orchestration unit-tests
 * without touching the network, ClickHouse, or Postgres.
 */
import { cloudflareR2ObjectUrl, sleep } from "@axel/shared";
import type pg from "pg";
import type { R2HttpDeps, ClickhouseHttpDeps } from "./replay-worker.js";

/** Raw payloads >= this age (days) are owned by the R2 bucket lifecycle rule. */
export const R2_LIFECYCLE_CEILING_DAYS = 30;
const DEFAULT_MIN_AGE_DAYS = 7;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_KEYS_PER_TICK = 50_000;
const DEFAULT_DELETE_CONCURRENCY = 8;
const DAY_MS = 86_400_000;

export interface RawRetentionScope {
  workspace_id: string;
  source_id: string;
  effective_days: number;
}

export interface R2KeyLister {
  /**
   * Distinct r2_keys for (workspace, source) with received_at < cutoff,
   * keyset-paginated by `r2_key > after`, capped at `limit`.
   */
  listKeys(args: {
    workspaceId: string;
    sourceId: string;
    cutoffIso: string;
    after: string;
    limit: number;
  }): Promise<string[]>;
}

export interface R2Deleter {
  delete(key: string): Promise<void>;
}

export interface SweepOptions {
  lister: R2KeyLister;
  deleter: R2Deleter;
  now?: () => Date;
  /** Never delete payloads younger than this (ms). Default 7 days. */
  minAgeMs?: number;
  /** ClickHouse page size. Default 1000. */
  pageSize?: number;
  /** Stop a tick after this many deletions; resume next tick. Default 50k. */
  maxKeysPerTick?: number;
  /** Parallel R2 deletes per page. Default 8. */
  concurrency?: number;
}

export interface R2RetentionSummary {
  scopes_considered: number;
  keys_deleted: number;
  keys_failed: number;
  budget_exhausted: boolean;
}

export async function sweepRawPayloadRetention(
  pool: pg.Pool,
  opts: SweepOptions,
): Promise<R2RetentionSummary> {
  const now = opts.now ?? (() => new Date());
  const minAgeMs = opts.minAgeMs ?? DEFAULT_MIN_AGE_DAYS * DAY_MS;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxKeys = opts.maxKeysPerTick ?? DEFAULT_MAX_KEYS_PER_TICK;
  const concurrency = opts.concurrency ?? DEFAULT_DELETE_CONCURRENCY;

  const scopes = await resolveScopes(pool);
  const summary: R2RetentionSummary = {
    scopes_considered: scopes.length,
    keys_deleted: 0,
    keys_failed: 0,
    budget_exhausted: false,
  };

  for (const scope of scopes) {
    if (summary.keys_deleted >= maxKeys) {
      summary.budget_exhausted = true;
      break;
    }
    // cutoff = now - max(effective, floor). Transient (0d) → now - floor. We
    // never delete younger than the floor, so an in-flight delivery can still
    // fetch its body from R2.
    const ageMs = Math.max(scope.effective_days * DAY_MS, minAgeMs);
    const cutoffIso = toClickhouseDateTime(new Date(now().getTime() - ageMs));

    let after = "";
    while (summary.keys_deleted < maxKeys) {
      const keys = await opts.lister.listKeys({
        workspaceId: scope.workspace_id,
        sourceId: scope.source_id,
        cutoffIso,
        after,
        limit: pageSize,
      });
      if (keys.length === 0) break;
      const { deleted, failed } = await deleteBatch(opts.deleter, keys, concurrency);
      summary.keys_deleted += deleted;
      summary.keys_failed += failed;
      after = keys[keys.length - 1]!;
      if (keys.length < pageSize) break;
    }
  }
  if (summary.keys_deleted >= maxKeys) summary.budget_exhausted = true;
  return summary;
}

/**
 * Every (workspace, source) whose effective raw retention is below the bucket
 * ceiling — the only scopes the sweeper needs to touch. A source override of
 * NULL inherits the workspace default.
 */
async function resolveScopes(pool: pg.Pool): Promise<RawRetentionScope[]> {
  const res = await pool.query<RawRetentionScope>(
    `SELECT s.id AS source_id,
            s.workspace_id,
            COALESCE(s.raw_payload_retention_days, w.raw_payload_retention_days) AS effective_days
       FROM sources s
       JOIN workspaces w ON w.id = s.workspace_id
      WHERE COALESCE(s.raw_payload_retention_days, w.raw_payload_retention_days) < $1`,
    [R2_LIFECYCLE_CEILING_DAYS],
  );
  return res.rows;
}

async function deleteBatch(
  deleter: R2Deleter,
  keys: string[],
  concurrency: number,
): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  for (let i = 0; i < keys.length; i += concurrency) {
    const slice = keys.slice(i, i + concurrency);
    const results = await Promise.allSettled(slice.map((key) => deleter.delete(key)));
    for (const r of results) {
      if (r.status === "fulfilled") deleted += 1;
      else failed += 1;
    }
  }
  return { deleted, failed };
}

/** "YYYY-MM-DD HH:MM:SS" — a ClickHouse DateTime literal (no T, no Z). */
function toClickhouseDateTime(d: Date): string {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

// ---- production adapters ---- //

/**
 * ClickHouse-backed key lister. Queries the `events` table over the HTTP
 * interface (same auth/format as the rest of delivery-service). The table's
 * ORDER BY (workspace_id, received_at, source_id, …) makes the workspace +
 * received_at filter index-friendly.
 */
export function createClickhouseR2KeyLister(deps: ClickhouseHttpDeps): R2KeyLister {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    async listKeys({ workspaceId, sourceId, cutoffIso, after, limit }) {
      const url = new URL(deps.url);
      url.searchParams.set("default_format", "JSON");
      url.searchParams.set("param_workspace_id", workspaceId);
      url.searchParams.set("param_source_id", sourceId);
      url.searchParams.set("param_cutoff", cutoffIso);
      url.searchParams.set("param_prefix", `events/${workspaceId}/`);
      url.searchParams.set("param_after", after);
      url.searchParams.set("param_limit", String(limit));
      url.searchParams.set("max_execution_time", "30");
      url.searchParams.set("max_threads", "2");
      const sql = `
        SELECT DISTINCT r2_key
          FROM events
         WHERE workspace_id = {workspace_id:String}
           AND source_id = {source_id:String}
           AND received_at < toDateTime64({cutoff:String}, 3)
           AND startsWith(r2_key, {prefix:String})
           AND r2_key > {after:String}
         ORDER BY r2_key
         LIMIT {limit:UInt32}`;
      const headers: Record<string, string> = {
        "content-type": "text/plain; charset=UTF-8",
        "X-ClickHouse-User": deps.user ?? "default",
      };
      if (deps.password) headers["X-ClickHouse-Key"] = deps.password;
      const res = await fetchImpl(url, {
        method: "POST",
        redirect: "manual",
        body: sql,
        headers,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`r2_retention_ch_${res.status}`);
      }
      const text = await res.text();
      if (!text.trim()) return [];
      const json = JSON.parse(text) as { data?: Array<{ r2_key: string }> };
      return (json.data ?? []).map((row) => row.r2_key).filter(Boolean);
    },
  };
}

/**
 * Cloudflare R2 object delete over the account-scoped HTTP API, with a modest
 * retry on throttles / 5xx. 404 is treated as success (already gone).
 */
export function createR2HttpDeleter(deps: R2HttpDeps): R2Deleter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxAttempts = 5;
  return {
    async delete(key: string): Promise<void> {
      const url = cloudflareR2ObjectUrl(
        deps.cloudflareAccountId,
        deps.rawPayloadBucket,
        key,
      );
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const res = await fetchImpl(url, {
          method: "DELETE",
          redirect: "manual",
          headers: { authorization: `Bearer ${deps.cloudflareApiToken}` },
        });
        if (res.ok || res.status === 404) return;
        const retriable = res.status === 429 || res.status >= 500;
        if (!retriable || attempt === maxAttempts) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`r2_delete_${res.status}`);
        }
        await res.body?.cancel().catch(() => undefined);
        await sleep(Math.min(8_000, 200 * 2 ** (attempt - 1)));
      }
    },
  };
}
