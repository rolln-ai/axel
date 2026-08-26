/**
 * GDPR per-subject erasure — subject-value extraction (Phase 1 foundation).
 *
 * The hard problem in erasing "all of a person's data" is the FINDER: a data
 * subject is identified by some value (email, customer id) that lives INSIDE
 * opaque per-source JSON payloads — or in a header / query param. This module
 * is the pure, inert primitive that turns a source's configured
 * `subject_key_paths` into the raw subject value(s) present on one event. A
 * later phase indexes those values (hashed) at ingest so an erasure request is
 * a cheap point lookup instead of a full R2/ClickHouse scan.
 *
 * Phase 1 is DEFAULT-INERT and called by nothing: `subject_key_paths` defaults
 * NULL, so extraction returns `[]` and ingest is byte-identical to baseline.
 *
 * Design notes (mirrored from the erasure design doc):
 *  - Subject identifiers routinely live in HEADERS or QUERY (`X-Customer-Email`,
 *    `?user_id=`), which the `events` row persists verbatim in
 *    headers_json/query_json — a body-only extractor would silently miss them.
 *    So each configured path carries a `loc` of body | header | query.
 *  - Extraction must run against the PRE-redaction body, because a subject path
 *    may itself be a redact path; the value must be captured before it becomes
 *    "[REDACTED]".
 *  - A non-JSON body, missing path, or non-scalar leaf yields nothing for that
 *    path. Array descent is intentionally unsupported (an array-valued subject
 *    is surfaced as zero-coverage at config time, never silently dropped).
 *  - This primitive returns RAW values. Normalization + hashing into a stable
 *    `subject_id` is the finder's job (it binds workspace_id + a version), kept
 *    separate so the pseudonymization posture is decided in one place.
 *
 * Pure — runs in Workers, Node, and tests.
 */

export type SubjectKeyLocation = "body" | "header" | "query";

/** Max distinct subject keys a source may configure. */
export const MAX_SUBJECT_KEY_PATHS = 10;

/**
 * Informational `kind` allowlist — drives subject-id normalization (only "email"
 * normalizes today; see subject-id.ts). Kept a fixed set so the UI is a dropdown
 * and a typo can't create a silently-distinct subject that erasure would miss.
 */
export const SUBJECT_KEY_KINDS = ["email", "id", "phone", "username", "other"] as const;

const SUBJECT_KEY_LOCATIONS: ReadonlySet<string> = new Set(["body", "header", "query"]);

export type SubjectKeyValidation =
  | { ok: true; value: SubjectKeyPath[] }
  | { ok: false; error: string };

/**
 * Validate + normalize user/API-supplied subject-key config before it is
 * persisted to `sources.subject_key_paths`. Enforces the location set, a
 * non-empty path, the `kind` allowlist, an array cap, and rejects array-descent
 * paths (which the extractor silently drops — so a bad config would index
 * nothing and erasure would find nothing). Exact duplicates are collapsed.
 */
export function validateSubjectKeyPaths(input: unknown): SubjectKeyValidation {
  if (input == null) return { ok: true, value: [] };
  if (!Array.isArray(input)) return { ok: false, error: "subject_key_paths must be an array" };
  if (input.length > MAX_SUBJECT_KEY_PATHS) {
    return { ok: false, error: `at most ${MAX_SUBJECT_KEY_PATHS} subject keys are allowed` };
  }
  const out: SubjectKeyPath[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") {
      return { ok: false, error: "each subject key must be an object" };
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.loc !== "string" || !SUBJECT_KEY_LOCATIONS.has(r.loc)) {
      return { ok: false, error: "loc must be one of: body, header, query" };
    }
    const path = typeof r.path === "string" ? r.path.trim() : "";
    if (!path) return { ok: false, error: "each subject key needs a non-empty path" };
    if (path.length > 200) return { ok: false, error: "path is too long (max 200 chars)" };
    if (path.includes("[")) {
      return { ok: false, error: "array paths ([]) are not supported for subject keys" };
    }
    let kind: string | undefined;
    if (r.kind !== undefined && r.kind !== null) {
      if (typeof r.kind !== "string") return { ok: false, error: "kind must be a string" };
      const k = r.kind.trim();
      if (k.length > 0) {
        if (!(SUBJECT_KEY_KINDS as readonly string[]).includes(k)) {
          return { ok: false, error: `kind must be one of: ${SUBJECT_KEY_KINDS.join(", ")}` };
        }
        kind = k;
      }
    }
    const dedupe = `${r.loc}:${path}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push(kind ? { loc: r.loc as SubjectKeyLocation, path, kind } : { loc: r.loc as SubjectKeyLocation, path });
  }
  return { ok: true, value: out };
}

export interface SubjectKeyPath {
  /** Where the value lives. */
  loc: SubjectKeyLocation;
  /** Dot-path into the JSON body (loc=body), or the header/query name. */
  path: string;
  /** Informational kind ("email" | "id" | …) used later for normalization. */
  kind?: string;
}

export interface SubjectKeyConfig {
  subject_key_paths?: SubjectKeyPath[] | null | undefined;
}

/**
 * Extract the distinct raw subject values present on one event, per the
 * source's configured `subject_key_paths`. Returns `[]` when nothing is
 * configured or nothing resolves — never throws, never drops the event.
 *
 * `headers` keys are expected lowercased (as ingest's collectHeaders produces);
 * the configured header name is lowercased to match. Order is preserved and
 * duplicates removed.
 */
export function extractSubjectValues(
  source: SubjectKeyConfig,
  rawBody: Uint8Array,
  headers: Record<string, string>,
  query: Record<string, string>,
): string[] {
  const configs = source.subject_key_paths;
  if (!configs || configs.length === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | null) => {
    if (value !== null && value.length > 0 && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  };

  // Parse the body lazily and at most once — only if a body path is configured.
  let bodyParsed: unknown;
  let bodyParseDone = false;
  const body = (): unknown => {
    if (!bodyParseDone) {
      bodyParseDone = true;
      try {
        bodyParsed = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        bodyParsed = undefined; // not JSON — no body keys
      }
    }
    return bodyParsed;
  };

  for (const cfg of configs) {
    const path = cfg.path?.trim();
    if (!path) continue;
    if (cfg.loc === "header") {
      push(scalar(headers[path.toLowerCase()]));
    } else if (cfg.loc === "query") {
      push(scalar(query[path]));
    } else {
      push(scalarAtPath(body(), path));
    }
  }
  return out;
}

/**
 * Like extractSubjectValues, but keeps each value's configured `kind` (needed to
 * derive a subject_id, whose normalization is kind-specific). Deduplicates by
 * (kind, value). Returns [] when nothing is configured/resolves. Never throws.
 */
export function extractSubjectPairs(
  source: SubjectKeyConfig,
  rawBody: Uint8Array,
  headers: Record<string, string>,
  query: Record<string, string>,
): Array<{ kind: string; value: string }> {
  const configs = source.subject_key_paths;
  if (!configs || configs.length === 0) return [];

  const out: Array<{ kind: string; value: string }> = [];
  const seen = new Set<string>();
  let bodyParsed: unknown;
  let bodyParseDone = false;
  const body = (): unknown => {
    if (!bodyParseDone) {
      bodyParseDone = true;
      try {
        bodyParsed = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        bodyParsed = undefined;
      }
    }
    return bodyParsed;
  };

  for (const cfg of configs) {
    const path = cfg.path?.trim();
    if (!path) continue;
    const kind = cfg.kind ?? "";
    const value =
      cfg.loc === "header"
        ? scalar(headers[path.toLowerCase()])
        : cfg.loc === "query"
          ? scalar(query[path])
          : scalarAtPath(body(), path);
    if (value === null || value.length === 0) continue;
    const dedupeKey = `${kind}\0${value}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    out.push({ kind, value });
  }
  return out;
}

/** Coerce a scalar (string/number/boolean) to a non-empty string, else null. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  return null;
}

/**
 * Walk a dot-path to a scalar leaf in an already-parsed JSON value. No `[]`
 * array descent: an array or object leaf yields null (a subject key must be a
 * single deterministic value).
 */
function scalarAtPath(parsed: unknown, path: string): string | null {
  if (parsed === undefined) return null;
  const segments = path
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return null;

  let node: unknown = parsed;
  for (const segment of segments) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return null;
    node = (node as Record<string, unknown>)[segment];
  }
  return scalar(node);
}
