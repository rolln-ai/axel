/**
 * GDPR erasure — subject-id derivation (shared, Web-Crypto).
 *
 * subject_id = "sub_" + sha256( "{normVersion} {workspace_id} {kind} {norm}" )
 *
 * The single source of truth for the normalization + the hashed-input string, so
 * the INGEST write-path (this Web-Crypto fn, in the ingest CF Worker) and the
 * dashboard READ-path (erasure-subject-id.ts, node:crypto) produce byte-identical
 * ids. sha256(hex) of the same UTF-8 string is identical across node:crypto and
 * Web Crypto, so the dashboard keeps its sync hasher and only the normalization +
 * input format live here. Bump SUBJECT_NORM_VERSION when normalizeSubjectValue
 * changes (a new version yields different ids rather than silently desyncing
 * writer from reader).
 *
 * Pseudonymous: the id is a hash, never a durable copy of the subject's PII.
 * workspace_id is bound in so the same raw value never collides across tenants.
 */

// Minimal Web-Platform globals (same rationale as signature-verify.ts).
declare const crypto: {
  subtle: { digest(algorithm: "SHA-256", data: ArrayBuffer | Uint8Array): Promise<ArrayBuffer> };
};
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

export const SUBJECT_NORM_VERSION = 1;

/** kind-specific normalization. Conservative by default — only the obvious email
 * case — so two distinct subjects are never merged (see erasure-subject-id §9.3). */
export function normalizeSubjectValue(kind: string, raw: string): string {
  switch (kind) {
    case "email":
      return raw.trim().toLowerCase();
    default:
      return raw;
  }
}

/** The exact string hashed into a subject_id — shared by both hashers. */
export function subjectIdInputString(
  workspaceId: string,
  kind: string,
  raw: string,
  normVersion: number = SUBJECT_NORM_VERSION,
): string {
  return `${normVersion} ${workspaceId} ${kind} ${normalizeSubjectValue(kind, raw)}`;
}

/** Web-Crypto subject-id derivation for the ingest worker. Matches the dashboard's
 * node:crypto deriveSubjectId byte-for-byte (asserted by a parity test). */
export async function deriveSubjectIdWeb(
  workspaceId: string,
  kind: string,
  raw: string,
  normVersion: number = SUBJECT_NORM_VERSION,
): Promise<string> {
  const bytes = new TextEncoder().encode(subjectIdInputString(workspaceId, kind, raw, normVersion));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sub_${subjectHex(new Uint8Array(digest))}`;
}

function subjectHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, "0");
  return out;
}
