import "server-only";
import type { ClickhouseQueryable } from "../clickhouse";
import { clickhouse } from "../clickhouse";
import { fetchPayloadForR2Key } from "../sample-payload";
import type { RawPayloadKeyExpectation } from "@axel/shared";

/**
 * Single sampled raw event ready for downstream inference (AXE-42).
 */
export interface SampledEvent {
  event_id: string;
  received_at: string;
  shard: number;
  headers: Record<string, unknown>;
  payload: unknown;
  /**
   * Cheap shape hash. Same hash = same set of nested keys (path → primitive
   * type). Inference uses this to cluster event types; we use it here to
   * dedupe near-identical events early.
   */
  shape_hash: string;
}

export interface SamplerOptions {
  /** Total cap on returned events. Default 200. */
  maxEvents?: number;
  /** Total cap on cumulative payload bytes. Default 5MB. */
  maxBytes?: number;
  /** Total cap on calendar days back to scan. Default 30 (matches CH TTL). */
  maxDays?: number;
  /**
   * Max payloads per day-bucket on day 0 (today). Halves each day back.
   *
   * Default is UNDEFINED = no per-day cap. With the hash-distributed
   * candidate ordering (2026-05-18), the pool is already
   * frequency-proportional across the whole retention window, so a
   * recency-decaying per-day cap only re-introduces the sampling bias
   * that change removed — and starves the highest-volume days (they
   * get the smallest decayed budget), which is exactly where a
   * dominant-traffic source hides its rare event types. Callers that
   * want a cheap, tight window (drift detection) opt back in by setting
   * this explicitly.
   */
  perDayBudgetToday?: number;
  /** Floor on per-day budget so we still see ancient events. Default 2. */
  perDayBudgetFloor?: number;
  /** Hard cap on R2 fetches issued (regardless of dedup outcome). Default 600. */
  maxFetches?: number;
  /**
   * Max samples kept per distinct shape cluster. Default 20.
   *
   * Earlier versions dedup'd to 1-per-shape, which was wrong for
   * inference: with a single sample, every field reads as "100% unique"
   * (1 distinct value out of 1) so we couldn't distinguish stable IDs
   * from low-cardinality enums. Keeping a small fan-out per shape gives
   * the inference enough rows to compute real per-field uniqueness,
   * type unions, presence rates, and enum value sets, while still
   * keeping the total payload bounded by `maxEvents`.
   */
  perShapeSampleLimit?: number;
  /**
   * Candidate pool size pulled from ClickHouse before payload fetching.
   * Default = max(maxEvents * 50, 1000), capped at 5000. We over-pull
   * aggressively because the ClickHouse query is metadata-only (cheap)
   * and the candidate ordering is hash-distributed, so a larger pool is
   * how we surface rare event types that aren't in the most-recent
   * window. The fetch budget (`maxFetches`) bounds the R2 cost
   * separately.
   */
  maxCandidates?: number;
  /**
   * Parallel R2 fetches per wave. Default 16. Webhook payloads tend to
   * be small, so the bottleneck is round-trip latency; batching gives
   * us a ~10× wall-clock win on a 200-sample run vs the old
   * one-at-a-time loop.
   */
  fetchConcurrency?: number;
  /** Inject a ClickHouse client (testing). */
  clickhouseClient?: ClickhouseQueryable;
  /** Inject the R2 payload fetcher (testing). */
  fetchPayload?: (
    r2Key: string,
    expected: RawPayloadKeyExpectation,
  ) => Promise<unknown>;
  /** Reference clock for decay buckets. Defaults to wall clock. */
  now?: () => Date;
  /**
   * Restrict the candidate pool to untyped rows (`event_type = ''`).
   *
   * Used by {@link sampleByEventTypeIndex} during the rollout/backfill
   * window: a partially-backfilled source can carry millions of legacy
   * untyped rows whose diversity the index's perTypeSamples-capped ''
   * bucket cannot represent, so the index delegates that bucket to this
   * hash-distributed shape sampler instead. Only set this when the
   * `event_type` column is known to exist (the index sampler sets it
   * after its own query succeeded) — pre-migration the filter would make
   * the candidate query throw.
   */
  untypedOnly?: boolean;
  /**
   * Whether R2 credentials are present. Defaults to checking
   * CLOUDFLARE_R2_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in process.env. Only used
   * to decide how to treat an "every payload unreadable" result: a genuine
   * creds gap escalates (throw), whereas creds-present-but-unreadable is
   * treated as benign retention-swept payloads (return []). Injectable so
   * tests don't depend on ambient env.
   */
  r2CredsPresent?: boolean;
}

interface CandidateRow {
  event_id: string;
  source_id: string;
  r2_key: string;
  /**
   * String-formatted timestamp. Named distinctly from the underlying
   * `received_at` column so the SELECT's `dateDiff(... received_at ...)`
   * can resolve to the raw DateTime64 column. ClickHouse resolves
   * SELECT-list aliases globally (not left-to-right), so an alias
   * literally named `received_at` will shadow the column in dateDiff's
   * 2nd argument and surface as `Code: 43 illegal type ... got: String`.
   */
  received_at_text: string;
  shard: number;
  size_bytes: number;
  day_offset: number;
}

/**
 * Compute a per-day budget that decays logarithmically as you walk back in
 * time. Day 0 (today) gets `today`. Each subsequent day halves, floored at
 * `floor` so we always grab at least a couple of events from old days. We
 * cap at 30 days to match the ClickHouse `events` TTL.
 */
function perDayBudgets(
  today: number,
  floor: number,
  maxDays: number,
): number[] {
  const budgets: number[] = [];
  for (let i = 0; i < maxDays; i++) {
    const decayed = Math.floor(today / Math.pow(2, i));
    budgets.push(Math.max(decayed, floor));
  }
  return budgets;
}

/**
 * Stable, order-independent hash of an object's nested shape.
 *
 * Two payloads that have the same set of (path → primitive type) entries
 * collapse to the same hash, regardless of how the keys were ordered when
 * serialized or what the actual values were. Used both for dedup here and
 * for event-type clustering in inference (AXE-42), so we keep it cheap and
 * deterministic.
 *
 * Note: this isn't cryptographic — collisions are fine for the dedup use
 * case (the worst we do is drop an event that happened to hash-collide with
 * an unrelated shape). FNV-1a 32-bit is plenty.
 */
export function shapeHash(value: unknown): string {
  const paths: string[] = [];
  walk(value, "", paths);
  paths.sort();
  return fnv1a(paths.join("\n"));
}

function walk(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push(`${path}:null`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out.push(`${path}:array`);
      return;
    }
    // Recurse into [0] only — array elements in webhook payloads almost
    // always share a shape, and recursing every element would blow up on
    // large arrays (Stripe's `events.data` lists, etc.).
    walk(value[0], `${path}[]`, out);
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      walk(obj[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  out.push(`${path}:${typeof value}`);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Sample raw events for a source. Returns a deduped, decay-weighted, byte-
 * and count-capped slice of payloads suitable as input for inference.
 *
 * Algorithm (rewritten 2026-05-18 to surface rare event types):
 *
 * 1. Pull a large candidate pool from ClickHouse, ordered by
 *    `cityHash64(event_id)` (deterministic but uncorrelated with
 *    `received_at`). This is the key change from the previous
 *    received_at-DESC pull: when one event type dominates traffic
 *    (95% `payment_intent.succeeded` on a Stripe source), the
 *    most-recent N rows were nearly all that one shape and rare
 *    types never made it into the candidate set. Hash-distributed
 *    ordering spreads the pool across the entire retention window
 *    proportionally to true frequency rather than recency, so a
 *    20+ event-type source actually surfaces all 20+.
 *
 * 2. By default, take the whole hash-distributed pool — no per-day
 *    cap. Hash-ordering already spreads candidates across time in
 *    proportion to true frequency, so an extra recency-decaying cap
 *    would only bias the sample back toward recent days and drop the
 *    rare types that live in the high-volume older days. Callers that
 *    want a cheap window (drift) opt into the decay budget explicitly.
 *
 * 3. Fetch payloads from R2 in parallel waves, hash the shape, and
 *    keep up to `perShapeSampleLimit` per shape. Crucially, hitting
 *    a saturated shape does NOT consume the fetch budget — we keep
 *    scanning candidates until we either fill `maxEvents` or hit
 *    the byte/fetch cap. The previous code burned the entire fetch
 *    budget on duplicates of the dominant shape.
 *
 * 4. Stop early once we've seen `EARLY_STOP_SATURATED_WINDOW`
 *    consecutive candidates that all map to already-saturated
 *    shapes — that's strong evidence the rest of the pool is more
 *    of the same and we're not going to find new types by paying
 *    for more R2 reads.
 */
const EARLY_STOP_SATURATED_WINDOW = 64;

export async function sampleSourceEvents(
  workspaceId: string,
  sourceId: string,
  options: SamplerOptions = {},
): Promise<SampledEvent[]> {
  const maxEvents = options.maxEvents ?? 200;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxDays = options.maxDays ?? 30;
  const perDayToday = options.perDayBudgetToday;
  const perDayFloor = options.perDayBudgetFloor ?? 2;
  const maxFetches = options.maxFetches ?? Math.max(maxEvents * 3, 100);
  const perShapeLimit = options.perShapeSampleLimit ?? 20;
  const fetchConcurrency = Math.max(1, options.fetchConcurrency ?? 16);
  const ch = options.clickhouseClient ?? clickhouse();
  const fetchPayload = options.fetchPayload ?? fetchPayloadForR2Key;
  const now = options.now ?? (() => new Date());

  // Candidate pool: large by default. The CH query is metadata-only
  // (event_id, r2_key, size, headers) so over-pulling is cheap; the
  // R2 fetches are the actual cost and they're gated separately by
  // `maxFetches`.
  const totalCandidateLimit = Math.min(
    options.maxCandidates ?? Math.max(maxEvents * 50, 1000),
    5000,
  );

  const result = await ch.query<CandidateRow>(
    `SELECT
       event_id,
       source_id,
       r2_key,
       -- Use a distinct alias (received_at_text) so the raw DateTime64
       -- column stays bound for dateDiff. ClickHouse resolves SELECT
       -- aliases globally, so aliasing back to the source column name
       -- would shadow it and dateDiff would get a String -> Code: 43.
       toString(received_at) AS received_at_text,
       dateDiff('day', received_at, now()) AS day_offset,
       shard,
       size_bytes
     FROM events
     WHERE workspace_id = {workspace_id:String}
       AND source_id = {source_id:String}
       AND received_at >= now() - INTERVAL {max_days:UInt32} DAY
       ${options.untypedOnly ? "AND event_type = ''" : ""}
     -- Hash-distributed ordering spreads candidates across the entire
     -- retention window rather than concentrating on the most-recent
     -- rows. Critical for sources where one event type dominates
     -- traffic — newest-first sampling would never reach the long tail.
     ORDER BY cityHash64(event_id)
     LIMIT {limit:UInt32}`,
    {
      workspace_id: workspaceId,
      source_id: sourceId,
      max_days: maxDays,
      limit: totalCandidateLimit,
    },
  );

  if (result.rows.length === 0) return [];

  // Per-day decay budget — OPT-IN only. Default (perDayBudgetToday
  // undefined) takes the full hash-distributed pool, since that pool is
  // already frequency-proportional and a recency-decay cap would bias it
  // back toward recent days and starve the rare types that live in the
  // highest-volume (most heavily decayed) days. Drift detection passes a
  // budget explicitly to keep its frequent runs cheap.
  let trimmed: CandidateRow[];
  if (perDayToday === undefined) {
    trimmed = result.rows;
  } else {
    const budgets = perDayBudgets(perDayToday, perDayFloor, maxDays);
    const dayCounts = new Map<number, number>();
    trimmed = [];
    for (const row of result.rows) {
      const day = Math.max(0, Math.min(maxDays - 1, Number(row.day_offset) || 0));
      const used = dayCounts.get(day) ?? 0;
      const budget = budgets[day] ?? perDayFloor;
      if (used >= budget) continue;
      dayCounts.set(day, used + 1);
      trimmed.push(row);
    }
  }

  // Suppress "now() unused" warnings — we keep `now` in the API surface so
  // tests can pin a reference clock for day_offset assertions even though
  // ClickHouse computes day_offset server-side.
  void now;

  // Per-shape sample counter. We keep up to perShapeLimit samples per
  // distinct shape so inference can compute real per-field statistics
  // (uniqueness, presence, enum values) instead of degenerate
  // "1-out-of-1" answers.
  const perShape = new Map<string, number>();
  const kept: SampledEvent[] = [];
  let bytes = 0;
  let fetches = 0;
  let unfetchable = 0;
  let consecutiveSaturated = 0;

  // Process candidates in parallel waves. For each wave, fetch
  // payloads concurrently, then apply the keep/skip decisions in
  // deterministic candidate order so test assertions on first-N stay
  // stable.
  for (let i = 0; i < trimmed.length; i += fetchConcurrency) {
    if (kept.length >= maxEvents) break;
    if (fetches >= maxFetches) break;
    if (consecutiveSaturated >= EARLY_STOP_SATURATED_WINDOW) break;

    const waveRows = trimmed.slice(i, i + fetchConcurrency);
    const wavePayloads = await Promise.all(
      waveRows.map(async (row) => {
        try {
          return await fetchPayload(row.r2_key, {
            workspaceId,
            eventId: row.event_id,
            sourceId,
          });
        } catch {
          return undefined;
        }
      }),
    );

    for (let j = 0; j < waveRows.length; j++) {
      if (kept.length >= maxEvents) break;
      if (fetches >= maxFetches) break;
      if (consecutiveSaturated >= EARLY_STOP_SATURATED_WINDOW) break;

      const row = waveRows[j]!;
      const payload = wavePayloads[j];
      if (payload === undefined || payload === null) {
        fetches++;
        unfetchable++;
        continue;
      }

      const hash = shapeHash(payload);
      const used = perShape.get(hash) ?? 0;
      if (used >= perShapeLimit) {
        // Saturated shape: don't keep, and don't charge the fetch
        // budget — the R2 read was already paid by the wave's
        // Promise.all, and counting saturated dupes against
        // `maxFetches` is exactly the bias we're fixing. We DO
        // count toward the consecutive-saturated early-stop window
        // so 1000 dupes in a row will eventually exit.
        consecutiveSaturated++;
        continue;
      }
      consecutiveSaturated = 0;
      fetches++;
      perShape.set(hash, used + 1);

      const size = Number(row.size_bytes) || 0;
      if (bytes + size > maxBytes && kept.length > 0) break;
      bytes += size;

      kept.push({
        event_id: row.event_id,
        received_at: row.received_at_text,
        shard: Number(row.shard) || 0,
        headers: {},
        payload,
        shape_hash: hash,
      });
    }
  }

  // CH had candidates but every R2 fetch returned null/undefined. This has
  // two very different causes and we must not conflate them:
  //
  //   1. R2 creds are actually missing → correlated across ALL sources at
  //      once; genuinely a "fix your R2 config" situation worth surfacing so
  //      callers show that instead of the generic "no events yet" notice.
  //   2. This one source's sampled payloads have simply aged out of R2. Raw
  //      payloads are swept as early as the ~7-day retention floor while
  //      ClickHouse metadata lives 30 days, so a low-traffic source can draw
  //      a candidate set whose payloads no longer exist. That's isolated and
  //      benign — NOT a creds problem, and mislabelling it as one produced a
  //      stream of false "check your Cloudflare token" Sentry alerts.
  //
  // `fetchPayloadForR2Key` returns null *before* any network call when creds
  // are absent, so creds-presence is what distinguishes the two. Only escalate
  // when creds are genuinely missing; otherwise treat swept payloads as "no
  // readable samples" (callers' detectDrift([]) / preview paths already no-op)
  // and let the next run retry newer traffic. We only reach here when CH
  // returned rows AND we attempted fetches, so an empty source still returns [].
  if (kept.length === 0 && unfetchable > 0 && unfetchable === fetches) {
    const credsPresent =
      options.r2CredsPresent ??
      Boolean(
        process.env.CLOUDFLARE_R2_API_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID,
      );
    if (!credsPresent) {
      throw new SamplerPayloadFetchError(
        `Couldn't read any payloads from R2 across ${unfetchable} candidate event${
          unfetchable === 1 ? "" : "s"
        }. Check CLOUDFLARE_R2_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the dashboard runtime.`,
      );
    }
    return [];
  }

  return kept;
}

export class SamplerPayloadFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamplerPayloadFetchError";
  }
}

/**
 * Sample for inference, preferring the exhaustive event-type index and
 * falling back to legacy random sampling when the index can't help (pre-
 * migration column, un-backfilled data, or untyped payloads). Call-compatible
 * with {@link sampleSourceEvents} so it can be dropped in as a default. The
 * fallback's SamplerPayloadFetchError still propagates.
 */
export async function sampleSourceEventsPreferIndex(
  workspaceId: string,
  sourceId: string,
  fallback: SamplerOptions = {},
  indexOptions: DistinctTypeSamplerOptions = {},
): Promise<SampledEvent[]> {
  const indexed = await sampleByEventTypeIndex(workspaceId, sourceId, indexOptions);
  if (indexed) return indexed;
  return sampleSourceEvents(workspaceId, sourceId, fallback);
}

export interface DistinctTypeSamplerOptions {
  /** Calendar days back to scan. Default 30 (CH TTL). */
  maxDays?: number;
  /**
   * Payloads fetched per distinct event type. Default 12 — enough for
   * inference to compute real per-field uniqueness / presence / enum stats
   * for each cluster, while keeping total R2 fetches tiny
   * (perType × #types, e.g. 12 × 25 = 300).
   */
  perTypeSamples?: number;
  /** Safety cap on distinct types pulled. Default 200. */
  maxTypes?: number;
  /** Parallel R2 fetches per wave. Default 16. */
  fetchConcurrency?: number;
  clickhouseClient?: ClickhouseQueryable;
  fetchPayload?: (
    r2Key: string,
    expected: RawPayloadKeyExpectation,
  ) => Promise<unknown>;
}

interface TypedCandidateRow {
  event_type: string;
  event_id: string;
  r2_key: string;
  received_at_text: string;
  shard: number;
  size_bytes: number;
}

/**
 * Exhaustive event-type sampling via the ClickHouse `event_type` index.
 *
 * This is the "distinct, then one sample per type" approach: instead of
 * randomly sampling payloads and hoping the long tail shows up, we ask
 * ClickHouse for a fixed number of events PER distinct `event_type`
 * (`LIMIT k BY event_type`). Every type that exists in the window is
 * returned exactly once, no matter how rare — a 0.001%-frequency type is as
 * visible as the dominant one. Then we fetch just those payloads from R2.
 *
 * Untyped events (`event_type = ''` — payloads with no recognizable
 * discriminator) are NOT excluded: they're pulled as their own bucket and
 * handed to inference, which sub-clusters them by payload shape (clusterIdFor
 * falls back to shape_hash when there's no type name). So a source that mixes
 * typed and untyped events still surfaces both. When the '' bucket hits its
 * per-type cap — the rollout window's partially-backfilled legacy backlog can
 * hide millions of rows behind ~perTypeSamples rows — the bucket is delegated
 * to the legacy hash-distributed shape sampler (restricted to untyped rows)
 * so its full diversity keeps reaching inference; see below.
 *
 * Returns null (caller falls back to the shape-based {@link sampleSourceEvents})
 * when the index can't help:
 *   - the `event_type` column doesn't exist yet (pre-migration) — the query
 *     throws and we swallow it,
 *   - or NO row carries a non-empty `event_type` (old un-backfilled data, or a
 *     source whose payloads are entirely untyped). For an all-untyped source
 *     the random sampler's shape clustering is strictly better than the single
 *     lumped '' bucket this query would return, so we defer to it.
 * That keeps every source working during the rollout + backfill window.
 */
export async function sampleByEventTypeIndex(
  workspaceId: string,
  sourceId: string,
  options: DistinctTypeSamplerOptions = {},
): Promise<SampledEvent[] | null> {
  const maxDays = options.maxDays ?? 30;
  const perType = Math.max(1, options.perTypeSamples ?? 12);
  const maxTypes = Math.max(1, options.maxTypes ?? 200);
  const fetchConcurrency = Math.max(1, options.fetchConcurrency ?? 16);
  const ch = options.clickhouseClient ?? clickhouse();
  const fetchPayload = options.fetchPayload ?? fetchPayloadForR2Key;

  let rows: TypedCandidateRow[];
  try {
    const result = await ch.query<TypedCandidateRow>(
      `SELECT
         event_type,
         event_id,
         r2_key,
         toString(received_at) AS received_at_text,
         shard,
         size_bytes
       FROM events
       WHERE workspace_id = {workspace_id:String}
         AND source_id = {source_id:String}
         AND received_at >= now() - INTERVAL {max_days:UInt32} DAY
       -- One bounded, hash-shuffled slice per distinct type. This is the
       -- exhaustive-discovery primitive: every event_type that exists in
       -- the window contributes up to {per_type} rows, so rare types can't
       -- be crowded out by dominant ones the way blind sampling does. The
       -- '' (untyped) bucket rides along as one group; inference re-splits
       -- it by shape.
       ORDER BY event_type, cityHash64(event_id)
       LIMIT {per_type:UInt32} BY event_type
       LIMIT {hard_cap:UInt32}`,
      {
        workspace_id: workspaceId,
        source_id: sourceId,
        max_days: maxDays,
        per_type: perType,
        hard_cap: maxTypes * perType,
      },
    );
    rows = result.rows;
  } catch {
    // Most likely the column doesn't exist yet (pre-migration). Signal the
    // caller to use the legacy random sampler.
    return null;
  }

  // No rows at all → empty source / un-backfilled. Fall back.
  if (rows.length === 0) return null;
  // Rows exist but every one is untyped → the index would collapse the whole
  // source into a single '' bucket. The random sampler's shape clustering is
  // strictly more informative, so defer to it.
  if (!rows.some((r) => r.event_type !== "")) return null;

  // Rollout/backfill hardening (2026-08-22): `LIMIT {per_type} BY event_type`
  // treats the whole untyped '' backlog as ONE bucket. During the staged
  // rollout a partially-backfilled source stamps types on new events while a
  // potentially huge legacy backlog still carries '', so the moment ANY row is
  // typed this query collapses that backlog into ~perType rows — far below
  // the up-to-maxEvents hash-distributed sample the pre-index sampler gave it.
  // When the '' bucket hit its cap (the only case where LIMIT BY actually
  // truncated it: fewer rows means every untyped event in the window was
  // captured exhaustively), delegate the bucket to the legacy shape sampler
  // restricted to untyped rows and use its richer sample instead. Best-effort:
  // if the supplement errors or comes back empty, keep the capped bucket rows.
  const untypedRowCount = rows.filter((r) => r.event_type === "").length;
  let untypedSupplement: SampledEvent[] = [];
  if (untypedRowCount >= perType) {
    try {
      untypedSupplement = await sampleSourceEvents(workspaceId, sourceId, {
        maxDays,
        untypedOnly: true,
        fetchConcurrency,
        ...(options.clickhouseClient ? { clickhouseClient: options.clickhouseClient } : {}),
        ...(options.fetchPayload ? { fetchPayload: options.fetchPayload } : {}),
      });
    } catch {
      // Includes SamplerPayloadFetchError (missing R2 creds). If creds are
      // genuinely gone the typed fetches below fail too, `kept` ends empty,
      // we return null, and the caller's legacy-sampler fallback re-raises
      // the error with the full "fix your R2 creds" guidance.
      untypedSupplement = [];
    }
    if (untypedSupplement.length > 0) {
      // The supplement replaces the capped '' bucket — drop the capped rows
      // so untyped events aren't double-fetched/double-counted.
      rows = rows.filter((r) => r.event_type !== "");
    }
  }

  // Truncation visibility: `LIMIT BY event_type` silently caps the number of
  // distinct types at maxTypes (the IN-window hard_cap = maxTypes × perType
  // also bounds it). When we hit that cap the long tail beyond maxTypes is
  // dropped from the contract without any signal, so warn — a source with more
  // distinct types than maxTypes is exactly the case where silent truncation
  // hides schema coverage. (Count is on the returned rows, so it's a lower
  // bound on the true distinct-type count, which is enough to flag truncation.)
  const distinctTypes = new Set(rows.map((r) => r.event_type)).size;
  if (distinctTypes >= maxTypes) {
    console.warn(
      `[data-contracts] event-type index returned ${distinctTypes} distinct types ` +
        `(>= maxTypes=${maxTypes}) — ` +
        `the long tail beyond maxTypes is truncated; raise maxTypes if needed.`,
    );
  }

  const kept: SampledEvent[] = [];
  for (let i = 0; i < rows.length; i += fetchConcurrency) {
    const wave = rows.slice(i, i + fetchConcurrency);
    const payloads = await Promise.all(
      wave.map(async (row) => {
        try {
          return await fetchPayload(row.r2_key, {
            workspaceId,
            eventId: row.event_id,
            sourceId,
          });
        } catch {
          return undefined;
        }
      }),
    );
    for (let j = 0; j < wave.length; j++) {
      const payload = payloads[j];
      if (payload === undefined || payload === null) continue;
      const row = wave[j]!;
      kept.push({
        event_id: row.event_id,
        received_at: row.received_at_text,
        shard: Number(row.shard) || 0,
        headers: {},
        payload,
        shape_hash: shapeHash(payload),
      });
    }
  }

  // CH had typed candidates but every R2 read failed → don't silently return
  // an empty contract. Returning null lets the caller fall through to the
  // random sampler, which raises SamplerPayloadFetchError with the
  // "fix your R2 creds" guidance. (Checked on the per-type rows alone: when
  // even the typed buckets are unreadable, the full-window legacy fallback is
  // the right owner of the whole sample, supplement included.)
  if (kept.length === 0) return null;
  // Append the delegated untyped-bucket sample. No dedupe needed: supplement
  // rows are exclusively event_type = '' and `rows` had those filtered out.
  kept.push(...untypedSupplement);
  return kept;
}

/**
 * Cheap metadata-only count of events for a source within the sampler's
 * scan window (`maxDays`, default 30 = CH TTL). Optionally counts only
 * events received strictly after `sinceIso` (used to measure how much new
 * traffic has arrived since a schema version was inferred).
 *
 * Used by the Data Contract page to decide whether a stored draft schema is
 * stale — inferred from a near-empty source, with lots of traffic since —
 * so it can be re-inferred on view. Returns 0 on any error so a transient
 * CH blip never breaks page render.
 */
export async function countSourceEvents(
  workspaceId: string,
  sourceId: string,
  options: {
    maxDays?: number;
    sinceIso?: string;
    clickhouseClient?: ClickhouseQueryable;
  } = {},
): Promise<number> {
  const maxDays = options.maxDays ?? 30;
  const ch = options.clickhouseClient ?? clickhouse();
  const sinceClause = options.sinceIso
    ? "AND received_at > {since:String}"
    : "";
  try {
    const result = await ch.query<{ n: string }>(
      `SELECT count() AS n
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND received_at >= now() - INTERVAL {max_days:UInt32} DAY
          ${sinceClause}`,
      {
        workspace_id: workspaceId,
        source_id: sourceId,
        max_days: maxDays,
        ...(options.sinceIso ? { since: toClickhouseDateTime(options.sinceIso) } : {}),
      },
    );
    return Number(result.rows[0]?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * Cheap metadata-only count of DISTINCT typed event types a source has emitted
 * within the scan window — the number the exhaustive `event_type` index sampler
 * would surface. Compared against a stored contract's captured type count on the
 * Data Contract page to flag a schema that under-counts types (e.g. one built by
 * the old proportional sampler before the index went live, where high-volume
 * types crowded out the long tail).
 *
 * Excludes the untyped (`event_type = ''`) bucket — it isn't a named type. Returns
 * 0 on any error (CH blip, or the column not existing pre-migration) so a stale
 * check never breaks page render or fires a false "stale" signal.
 */
export async function countDistinctEventTypes(
  workspaceId: string,
  sourceId: string,
  options: { maxDays?: number; clickhouseClient?: ClickhouseQueryable } = {},
): Promise<number> {
  const maxDays = options.maxDays ?? 30;
  const ch = options.clickhouseClient ?? clickhouse();
  try {
    const result = await ch.query<{ n: string }>(
      `SELECT uniqExactIf(event_type, event_type != '') AS n
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND received_at >= now() - INTERVAL {max_days:UInt32} DAY`,
      { workspace_id: workspaceId, source_id: sourceId, max_days: maxDays },
    );
    return Number(result.rows[0]?.n ?? 0) || 0;
  } catch {
    return 0;
  }
}

/**
 * The distinct typed event-type NAMES a source has emitted in the window,
 * most-frequent first. Metadata-only (no R2 payload fetches) — used by the
 * drift cron to detect long-tail event types that a proportional payload
 * sample can't surface, so a single missed rare type still triggers the
 * exhaustive auto-extend. Excludes the untyped ('') bucket. Returns [] on any
 * error (pre-migration column / CH blip) so drift detection degrades to the
 * shape-based sampler rather than throwing.
 */
export async function listDistinctEventTypes(
  workspaceId: string,
  sourceId: string,
  options: { maxDays?: number; limit?: number; clickhouseClient?: ClickhouseQueryable } = {},
): Promise<string[]> {
  const maxDays = options.maxDays ?? 30;
  const limit = Math.max(1, options.limit ?? 500);
  const ch = options.clickhouseClient ?? clickhouse();
  try {
    const result = await ch.query<{ event_type: string }>(
      `SELECT event_type
         FROM events
        WHERE workspace_id = {workspace_id:String}
          AND source_id = {source_id:String}
          AND event_type != ''
          AND received_at >= now() - INTERVAL {max_days:UInt32} DAY
        GROUP BY event_type
        ORDER BY count() DESC
        LIMIT {limit:UInt32}`,
      { workspace_id: workspaceId, source_id: sourceId, max_days: maxDays, limit },
    );
    return result.rows
      .map((r) => r.event_type)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch {
    return [];
  }
}

/**
 * Convert an ISO timestamp (Postgres `created_at`) to the
 * `YYYY-MM-DD HH:MM:SS.mmm` form ClickHouse's DateTime64 string parser
 * accepts. A bare ISO string with a `T` and `Z` is rejected by CH's
 * implicit String→DateTime64 cast, so normalise it here.
 */
function toClickhouseDateTime(iso: string): string {
  return iso.replace("T", " ").replace("Z", "").slice(0, 23);
}
