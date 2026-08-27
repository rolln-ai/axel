import "server-only";
import { db, type Queryable } from "./db";
import { deriveSubjectIds, type SubjectIdentifier } from "./erasure-subject-id";

/**
 * GDPR erasure — finder (Phase 2). Resolves a data subject to the set of
 * events to erase via a POINT LOOKUP on the `erasure_subjects` index — never a
 * full R2/ClickHouse scan. Read-only: it issues no deletes and writes no audit
 * row (the request lifecycle + audit persistence is a later phase). The
 * destructive executor is separate and gated (see erasure-executor.ts).
 */

export interface ErasureMatch {
  event_id: string;
  r2_key: string | null;
  received_at: string;
}

export type ErasureCoverage = "full_within_window" | "partial" | "unknown";

export interface FindResult {
  subjectIds: string[];
  matches: ErasureMatch[];
  coverage: ErasureCoverage;
  /** Earliest time the index can cover (min subject_indexing_active_since). */
  indexWindowFrom: string | null;
  /** Honest disclosure of what we could NOT search / confirm. */
  uncovered: Array<{ store: string; reason: string }>;
}

export interface FinderDeps {
  query?: Queryable;
}

interface SubjectRow {
  event_id: string;
  r2_key: string | null;
  received_at: string;
}
interface CoverageRow {
  window_from: string | null;
  configured_sources: string | number;
}

/**
 * The Postgres tables holding event-derived PII that have NO event_id and so
 * cannot be reached by the event-id-scoped executor — disclosed on every
 * request as out-of-scope-for-automated-erasure (design §3.5 / §9.4).
 */
const OUT_OF_SCOPE_DISCLOSURE: Array<{ store: string; reason: string }> = [
  { store: "postgres:billing_events.payload", reason: "Stripe customer PII, no event_id linkage — manual review" },
  { store: "postgres:notifications", reason: "body_md/metadata, no event_id linkage — manual review" },
  { store: "postgres:dead_letter_mutes", reason: "keyed by fingerprint, not event_id — manual review" },
  { store: "clickhouse:events_daily", reason: "uniqExact aggregate cannot be surgically retracted; non-PII counts, expires at 30-day TTL" },
];

export async function findSubjectEvents(
  workspaceId: string,
  identifiers: SubjectIdentifier[],
  deps: FinderDeps = {},
): Promise<FindResult> {
  const q = deps.query ?? db();
  const subjectIds = deriveSubjectIds(workspaceId, identifiers);

  if (subjectIds.length === 0) {
    return {
      subjectIds: [],
      matches: [],
      coverage: "unknown",
      indexWindowFrom: null,
      uncovered: [{ store: "input", reason: "no usable subject identifiers supplied" }],
    };
  }

  const matchRes = await q.query<SubjectRow>(
    // Normalize received_at to a UTC wall-clock string. We slice its date part to
    // build the ClickHouse partition prune, and ClickHouse toDate() is UTC — so
    // forcing UTC here (rather than a raw ::text, which renders in the PG session
    // timezone) keeps the prune timezone-independent. A raw timestamptz would
    // also arrive as a JS Date and interpolate as an unparseable literal.
    `SELECT event_id, r2_key, (received_at AT TIME ZONE 'UTC')::text AS received_at
       FROM erasure_subjects
      WHERE workspace_id = $1 AND subject_id = ANY($2)
      ORDER BY received_at`,
    [workspaceId, subjectIds],
  );
  // The same event can be indexed under several subject_ids (email AND id);
  // de-duplicate to a distinct event set.
  const byEvent = new Map<string, ErasureMatch>();
  for (const row of matchRes.rows) {
    if (!byEvent.has(row.event_id)) {
      byEvent.set(row.event_id, { event_id: row.event_id, r2_key: row.r2_key, received_at: row.received_at });
    }
  }
  const matches = [...byEvent.values()];

  const covRes = await q.query<CoverageRow>(
    `SELECT min(subject_indexing_active_since) AS window_from,
            count(*) FILTER (WHERE subject_key_paths IS NOT NULL) AS configured_sources
       FROM sources
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  const cov = covRes.rows[0];
  const configured = Number(cov?.configured_sources ?? 0);
  const indexWindowFrom = cov?.window_from ?? null;

  const { coverage, uncovered } = assessCoverage(configured, indexWindowFrom);

  return { subjectIds, matches, coverage, indexWindowFrom, uncovered };
}

/**
 * FLAGGED DEFAULT (design §1, §9.1-9.2): we NEVER report `full_within_window`
 * in this phase. Proving completeness needs per-event provenance we don't have,
 * and for opaque-payload subjects retroactive completeness is unprovable by
 * construction. So:
 *   - no source has subject_key_paths / no indexing window -> `unknown`
 *     (the feature can't even claim to have searched);
 *   - otherwise -> `partial`, disclosing the pre-window gap + out-of-scope
 *     stores. Erasing the located set is real; claiming it's everything is not.
 */
function assessCoverage(
  configuredSources: number,
  indexWindowFrom: string | null,
): { coverage: ErasureCoverage; uncovered: FindResult["uncovered"] } {
  if (configuredSources === 0 || indexWindowFrom === null) {
    return {
      coverage: "unknown",
      uncovered: [
        { store: "index", reason: "no source has subject indexing enabled — the index cannot locate this subject's events" },
        ...OUT_OF_SCOPE_DISCLOSURE,
      ],
    };
  }
  return {
    coverage: "partial",
    uncovered: [
      { store: "pre-index window", reason: `events ingested before ${indexWindowFrom} are not indexed and cannot be located cheaply` },
      { store: "non-JSON / array-valued subjects", reason: "events whose subject value did not resolve to a scalar were never indexed" },
      ...OUT_OF_SCOPE_DISCLOSURE,
    ],
  };
}
