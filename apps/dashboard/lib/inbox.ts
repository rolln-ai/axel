import "server-only";

import { cache } from "react";
import { deadLetterFingerprint, sanitizeConnectorDiagnosticForStorage } from "@axel/shared";
import { db } from "./db";

/**
 * Inbox-zero workflow for dead letters (AXE-57).
 *
 * The dashboard's existing /deliveries page renders dead letters as a
 * flat list — fine when there are 5, useless when there are 5,000
 * from the same Stripe outage. This module groups dead letters by an
 * opaque fingerprint so 5,000 rows collapse into one inbox entry the
 * operator can act on as a unit.
 *
 * Fingerprint formula: stable hash of (route_id, reason, normalised
 * leading slug of message). Stored in the new `dead_letter_mutes`
 * table when the operator silences a fingerprint; the inbox query
 * filters out fingerprints with a non-expired mute.
 *
 * The formula is intentionally simple — we want the same fingerprint
 * for two failures that are obviously the same root cause and a
 * different fingerprint when one detail changes (a different route, a
 * different reason slug, a different leading word in the message).
 *
 * The formula itself now lives in @axel/shared (`deadLetterFingerprint`) so the
 * dead_letters writers (delivery-edge, delivery-service) stamp the stored
 * `fingerprint` column with the exact same hash the inbox recomputes here —
 * which is what lets bulk replay skip muted fingerprints in SQL. It is async
 * (Web Crypto), so callers below await it.
 */

export async function fingerprintFor(input: {
  route_id: string | null;
  reason: string;
  message: string;
}): Promise<string> {
  return deadLetterFingerprint(input);
}

export interface InboxGroup {
  fingerprint: string;
  /** Unresolved dead-letter count in this fingerprint. */
  count: number;
  /**
   * Dead letters in this fingerprint that have been resolved in the
   * last 24h. Surfaces as "X resolved in 24h" on each row so the
   * operator gets feedback after clicking Retry — previously they had
   * no signal whether the replay landed.
   */
  resolved_24h: number;
  /** Earliest timestamp of an unresolved letter in the group, ISO. */
  first_seen: string;
  /** Most recent timestamp of an unresolved letter in the group, ISO. */
  last_seen: string;
  /**
   * Most recent resolved_at across the group, ISO. Null when no
   * letters in this fingerprint have ever been resolved.
   */
  last_resolved_at: string | null;
  /** Representative dead-letter id we'll deep-link to from the row. */
  exemplar_id: string;
  reason: string;
  message_excerpt: string;
  source_id: string | null;
  destination_id: string | null;
  route_id: string | null;
  /** Set when the fingerprint has an active mute. */
  muted_until: string | null;
  muted_reason: string | null;
  /** Jev's typed reason for the newest unresolved letter, when triaged. */
  triage_reason: string | null;
  triage_confidence: number | null;
  /** Unresolved letters in the group that Axel auto-replayed. */
  auto_replayed: number;
}

interface RawRow {
  id: string;
  reason: string;
  message: string;
  source_id: string | null;
  route_id: string | null;
  destination_id: string | null;
  errored_at: string;
  resolved_at: string | null;
  triage_reason: string | null;
  triage_confidence: number | null;
  auto_replay_id: string | null;
}

interface MuteRow {
  fingerprint: string;
  reason: string | null;
  until: string | null;
}

/**
 * Pull every unresolved dead letter for the workspace, group by
 * fingerprint, fold in active mutes. Bounded at 1000 unresolved DLs —
 * after that we're in incident-management territory and the operator
 * should be using bulk mute anyway.
 *
 * Also pulls letters resolved in the last 24h so each fingerprint can
 * surface "X resolved in 24h" — gives the operator feedback after
 * clicking Retry. Without this, the inbox row stays visible after
 * retry (because Retry doesn't change `count`) and the operator has
 * no way to tell whether the replay landed.
 *
 * Wrapped in React's `cache()` so the AppShell badge count and the
 * /inbox page rendering coalesce onto a single PG round-trip per request.
 */
export const loadInboxGroups = cache(async (workspaceId: string): Promise<InboxGroup[]> => {
  const [unresolvedRes, recentlyResolvedRes, mutesRes] = await Promise.all([
    db().query<RawRow>(
      `SELECT dl.id::text,
              dl.reason,
              dl.message,
              dl.source_id,
              dl.route_id,
              NULLIF(dl.destination_id, '') AS destination_id,
              dl.errored_at::text AS errored_at,
              null::text AS resolved_at,
              dl.triage_reason,
              dl.triage_confidence,
              dl.auto_replay_id
         FROM dead_letters dl
        WHERE dl.workspace_id = $1
          AND dl.resolved_at IS NULL
        ORDER BY dl.errored_at DESC
        LIMIT 1000`,
      [workspaceId],
    ),
    db().query<RawRow>(
      `SELECT dl.id::text,
              dl.reason,
              dl.message,
              dl.source_id,
              dl.route_id,
              NULLIF(dl.destination_id, '') AS destination_id,
              dl.errored_at::text AS errored_at,
              dl.resolved_at::text AS resolved_at,
              dl.triage_reason,
              dl.triage_confidence,
              dl.auto_replay_id
         FROM dead_letters dl
        WHERE dl.workspace_id = $1
          AND dl.resolved_at IS NOT NULL
          AND dl.resolved_at > now() - interval '24 hours'
        ORDER BY dl.resolved_at DESC
        LIMIT 1000`,
      [workspaceId],
    ),
    db().query<MuteRow>(
      `SELECT fingerprint, reason, until::text
         FROM dead_letter_mutes
        WHERE workspace_id = $1
          AND (until IS NULL OR until > now())`,
      [workspaceId],
    ),
  ]);

  const muteByFingerprint = new Map<string, MuteRow>();
  for (const m of mutesRes.rows) muteByFingerprint.set(m.fingerprint, m);

  const groupByFingerprint = new Map<string, InboxGroup>();

  // First pass — unresolved rows seed each group (always show these).
  for (const row of unresolvedRes.rows) {
    const fp = await fingerprintFor({
      route_id: row.route_id,
      reason: row.reason,
      message: row.message,
    });
    const mute = muteByFingerprint.get(fp);
    const existing = groupByFingerprint.get(fp);
    if (existing) {
      existing.count += 1;
      if (row.errored_at < existing.first_seen) existing.first_seen = row.errored_at;
      if (row.errored_at > existing.last_seen) existing.last_seen = row.errored_at;
      if (row.auto_replay_id) existing.auto_replayed += 1;
      if (existing.triage_reason === null && row.triage_reason) {
        existing.triage_reason = row.triage_reason;
        existing.triage_confidence = row.triage_confidence;
      }
      continue;
    }
    groupByFingerprint.set(fp, {
      fingerprint: fp,
      count: 1,
      resolved_24h: 0,
      first_seen: row.errored_at,
      last_seen: row.errored_at,
      last_resolved_at: null,
      exemplar_id: row.id,
      reason: row.reason,
      message_excerpt: sanitizeConnectorDiagnosticForStorage(row.message, 200),
      source_id: row.source_id,
      destination_id: row.destination_id,
      route_id: row.route_id,
      muted_until: mute?.until ?? null,
      muted_reason: mute?.reason ?? null,
      triage_reason: row.triage_reason ?? null,
      triage_confidence: row.triage_confidence ?? null,
      auto_replayed: row.auto_replay_id ? 1 : 0,
    });
  }

  // Second pass — recently-resolved rows. Fold into existing groups
  // (incrementing `resolved_24h`) AND seed new "archived" groups for
  // fingerprints that have no unresolved letters left. Those archived
  // entries are needed for the /inbox?show=resolved view.
  for (const row of recentlyResolvedRes.rows) {
    const fp = await fingerprintFor({
      route_id: row.route_id,
      reason: row.reason,
      message: row.message,
    });
    const existing = groupByFingerprint.get(fp);
    if (existing) {
      existing.resolved_24h += 1;
      if (row.resolved_at && (!existing.last_resolved_at || row.resolved_at > existing.last_resolved_at)) {
        existing.last_resolved_at = row.resolved_at;
      }
      continue;
    }
    const mute = muteByFingerprint.get(fp);
    groupByFingerprint.set(fp, {
      fingerprint: fp,
      count: 0,
      resolved_24h: 1,
      first_seen: row.errored_at,
      last_seen: row.errored_at,
      last_resolved_at: row.resolved_at,
      exemplar_id: row.id,
      reason: row.reason,
      message_excerpt: sanitizeConnectorDiagnosticForStorage(row.message, 200),
      source_id: row.source_id,
      destination_id: row.destination_id,
      route_id: row.route_id,
      muted_until: mute?.until ?? null,
      muted_reason: mute?.reason ?? null,
      triage_reason: row.triage_reason ?? null,
      triage_confidence: row.triage_confidence ?? null,
      auto_replayed: row.auto_replay_id ? 1 : 0,
    });
  }

  // Sort: unmuted first (most recent unresolved first), then muted at the end.
  // Groups with count=0 (archive-only) sort to the bottom of their tier so the
  // active view shows live problems at the top.
  return Array.from(groupByFingerprint.values()).sort((a, b) => {
    const am = a.muted_until !== null;
    const bm = b.muted_until !== null;
    if (am !== bm) return am ? 1 : -1;
    if ((a.count === 0) !== (b.count === 0)) return a.count === 0 ? 1 : -1;
    return b.last_seen.localeCompare(a.last_seen);
  });
});

export interface DeadLetterIdsForFingerprint {
  ids: string[];
  /** Distinct (event_id, route_id, source_id, r2_key, reason) tuples for replay. */
  replays: Array<{
    event_id: string;
    route_id: string | null;
    source_id: string;
    r2_key: string;
    reason: string;
  }>;
  /**
   * True if the unresolved-letter scan hit its safety cap before exhausting
   * the workspace — an incident-scale fingerprint. The caller surfaces this
   * so the operator knows to run the action again to catch the remainder,
   * rather than silently dropping letters (the old LIMIT 1000 behaviour).
   */
  truncated: boolean;
}

/** Keyset page size for the unresolved-letter scan. */
const RESOLVE_PAGE = 2000;
/** Stop scanning after this many unresolved letters and report `truncated`. */
export const RESOLVE_SCAN_CAP = 100_000;

/**
 * Resolve a fingerprint back to the underlying dead-letter ids + distinct
 * replay tuples — used by bulk retry / mark-investigated actions.
 *
 * Only UNRESOLVED letters are considered (`resolved_at IS NULL`) so a repeat
 * action can't re-process letters that already resolved. The fingerprint is a
 * JS hash (`fingerprintFor`), so matching happens here rather than in SQL; to
 * avoid silently dropping a large fingerprint we keyset-paginate through every
 * unresolved letter (up to RESOLVE_SCAN_CAP) instead of a single LIMIT.
 */
export async function resolveFingerprintIds(
  workspaceId: string,
  fingerprint: string,
): Promise<DeadLetterIdsForFingerprint> {
  const ids: string[] = [];
  const replaySet = new Set<string>();
  const replays: DeadLetterIdsForFingerprint["replays"] = [];

  type Row = {
    id: string;
    event_id: string;
    reason: string;
    message: string;
    source_id: string;
    route_id: string | null;
    r2_key: string;
    errored_at: string;
  };

  let cursor: { errored_at: string; id: string } | null = null;
  let scanned = 0;
  let truncated = false;
  for (;;) {
    const page: { rows: Row[] } = cursor
      ? await db().query<Row>(
          `SELECT id::text, event_id, reason, message, source_id, route_id, r2_key,
                  errored_at::text AS errored_at
             FROM dead_letters
            WHERE workspace_id = $1
              AND resolved_at IS NULL
              AND (errored_at, id) < ($2::timestamptz, $3::bigint)
            ORDER BY errored_at DESC, id DESC
            LIMIT $4`,
          [workspaceId, cursor.errored_at, cursor.id, RESOLVE_PAGE],
        )
      : await db().query<Row>(
          `SELECT id::text, event_id, reason, message, source_id, route_id, r2_key,
                  errored_at::text AS errored_at
             FROM dead_letters
            WHERE workspace_id = $1
              AND resolved_at IS NULL
            ORDER BY errored_at DESC, id DESC
            LIMIT $2`,
          [workspaceId, RESOLVE_PAGE],
        );

    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const fp = await fingerprintFor({
        route_id: row.route_id,
        reason: row.reason,
        message: row.message,
      });
      if (fp !== fingerprint) continue;
      ids.push(row.id);
      const key = `${row.event_id}|${row.route_id ?? ""}`;
      if (!replaySet.has(key)) {
        replaySet.add(key);
        replays.push({
          event_id: row.event_id,
          route_id: row.route_id,
          source_id: row.source_id,
          r2_key: row.r2_key,
          reason: row.reason,
        });
      }
    }

    scanned += page.rows.length;
    const last = page.rows[page.rows.length - 1]!;
    cursor = { errored_at: last.errored_at, id: last.id };
    if (page.rows.length < RESOLVE_PAGE) break;
    if (scanned >= RESOLVE_SCAN_CAP) {
      truncated = true;
      break;
    }
  }
  return { ids, replays, truncated };
}
