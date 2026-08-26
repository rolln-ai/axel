import "server-only";
import { createHash } from "node:crypto";
import { SUBJECT_NORM_VERSION, normalizeSubjectValue, subjectIdInputString } from "@axel/shared";

// The normalization + hashed-input format are single-sourced in @axel/shared so
// this READ-path (node:crypto) matches the ingest WRITE-path (Web Crypto) exactly.
export { SUBJECT_NORM_VERSION, normalizeSubjectValue };

/**
 * GDPR erasure — subject-id derivation (read path).
 *
 * Turns a raw subject identifier (email, customer id, …) into the stable,
 * pseudonymous `subject_id` used as the index key in `erasure_subjects`:
 *
 *   subject_id = "sub_" + sha256( "{normVersion} {workspace_id} {kind} {norm}" )
 *
 *  - Hashing makes the index a pseudonymous locator, never a durable copy of the
 *    subject's plaintext PII (even when the configured path overlaps a redact path).
 *  - workspace_id is bound INTO the hash so the same raw value never collides
 *    across tenants.
 *  - The normalization version is bound in, so a future normalization change
 *    produces different ids rather than silently desyncing the ingest writer from
 *    the erasure reader. The format + normalize + SUBJECT_NORM_VERSION live in
 *    @axel/shared (subjectIdInputString), shared with the ingest Web-Crypto writer.
 *
 * FLAGGED DEFAULTS (open question §9.3 — shared-value over-erasure): two real
 * people who share a configured value (a family email, an org-level tenant id)
 * collapse to ONE subject_id and would be erased together. We have no identity
 * graph; the caller is expected to apply a cardinality guard before executing.
 * Normalization is intentionally conservative (only the obvious email case) to
 * avoid widening that collision surface.
 */

export interface SubjectIdentifier {
  /** "email" | "id" | … — selects normalization and namespaces the hash. */
  kind: string;
  value: string;
}

export function deriveSubjectId(
  workspaceId: string,
  kind: string,
  raw: string,
  normVersion: number = SUBJECT_NORM_VERSION,
): string {
  // Same input string the shared Web-Crypto writer hashes — keeps ingest-write
  // and dashboard-read subject_ids identical.
  const digest = createHash("sha256")
    .update(subjectIdInputString(workspaceId, kind, raw, normVersion))
    .digest("hex");
  return `sub_${digest}`;
}

/** Derive the distinct subject_ids for a set of (kind, value) identifiers. */
export function deriveSubjectIds(
  workspaceId: string,
  identifiers: SubjectIdentifier[],
  normVersion: number = SUBJECT_NORM_VERSION,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const { kind, value } of identifiers) {
    if (!value || value.length === 0) continue;
    const id = deriveSubjectId(workspaceId, kind, value, normVersion);
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
