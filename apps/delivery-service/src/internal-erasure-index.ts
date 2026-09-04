import { isInternalSecretAuthorized } from "./internal-source.js";

const SUBJECT_ID = /^sub_[a-f0-9]{64}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,160}$/;
const MAX_SUBJECT_IDS = 64;
const MAX_SOURCE_ID_BYTES = 256;
const MAX_R2_KEY_BYTES = 1_024;

export interface ErasureIndexPool {
  query<T>(text: string, values: unknown[]): Promise<{ rows: T[] }>;
}

export interface InternalErasureIndexRequest {
  providedSecret: string | string[] | undefined;
  readBody(): Promise<string>;
}

export interface InternalErasureIndexDependencies {
  sharedSecret: string;
  previousSharedSecret?: string;
  pool: ErasureIndexPool;
  onError?(error: unknown, sourceId: string | undefined): void;
}

export interface InternalErasureIndexHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: { ok: true } | { ok: false; error: string };
}

interface ErasureIndexBody {
  source_id: string;
  subject_ids: string[];
  event_id: string;
  r2_key: string;
  received_at: string;
}

interface IndexResultRow {
  source_exists: boolean;
  r2_key_matches: boolean;
}

const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};

function invalid(status: number, error: string): InternalErasureIndexHttpResponse {
  return { status, headers: JSON_HEADERS, body: { ok: false, error } };
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return true;
  }
  return false;
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !hasControlCharacters(value);
}

function parseBody(raw: string): ErasureIndexBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (
    keys.join(",")
    !== "event_id,r2_key,received_at,source_id,subject_ids"
  ) return null;
  if (!boundedText(body.source_id, MAX_SOURCE_ID_BYTES)) return null;
  if (typeof body.event_id !== "string" || !EVENT_ID.test(body.event_id)) return null;
  if (!boundedText(body.r2_key, MAX_R2_KEY_BYTES)) return null;
  if (
    typeof body.received_at !== "string"
    || body.received_at.length > 64
    || !Number.isFinite(Date.parse(body.received_at))
  ) return null;
  if (
    !Array.isArray(body.subject_ids)
    || body.subject_ids.length === 0
    || body.subject_ids.length > MAX_SUBJECT_IDS
    || !body.subject_ids.every((value) => typeof value === "string" && SUBJECT_ID.test(value))
    || new Set(body.subject_ids).size !== body.subject_ids.length
  ) return null;
  return body as unknown as ErasureIndexBody;
}

/** Testable core for POST /internal/erasure-subjects. */
export async function handleInternalErasureIndexRequest(
  request: InternalErasureIndexRequest,
  dependencies: InternalErasureIndexDependencies,
): Promise<InternalErasureIndexHttpResponse> {
  const authorized = isInternalSecretAuthorized(
    request.providedSecret,
    dependencies.sharedSecret,
  ) || isInternalSecretAuthorized(
    request.providedSecret,
    dependencies.previousSharedSecret ?? "",
  );
  if (!authorized) return invalid(401, "unauthorized");

  const body = parseBody(await request.readBody());
  if (!body) return invalid(400, "invalid_body");

  try {
    const result = await dependencies.pool.query<IndexResultRow>(
      `WITH source_workspace AS (
         SELECT workspace_id
           FROM sources
          WHERE id = $1
          LIMIT 1
       ), input_subjects AS (
         SELECT subject_id
           FROM unnest($2::text[]) AS subject_id
       ), inserted AS (
         INSERT INTO erasure_subjects (
           workspace_id, subject_id, event_id, r2_key, received_at
         )
         SELECT source.workspace_id, input.subject_id, $3, $4, $5::timestamptz
           FROM source_workspace source
           CROSS JOIN input_subjects input
          WHERE $4 LIKE ('events/' || source.workspace_id || '/%')
            AND right($4, length($3) + 1) = ('/' || $3)
         ON CONFLICT DO NOTHING
         RETURNING 1
       )
       SELECT EXISTS (SELECT 1 FROM source_workspace) AS source_exists,
              COALESCE((
                SELECT $4 LIKE ('events/' || workspace_id || '/%')
                   AND right($4, length($3) + 1) = ('/' || $3)
                  FROM source_workspace
              ), false) AS r2_key_matches`,
      [
        body.source_id,
        body.subject_ids,
        body.event_id,
        body.r2_key,
        body.received_at,
      ],
    );
    const row = result.rows[0];
    if (!row?.source_exists) return invalid(404, "source_not_found");
    if (!row.r2_key_matches) return invalid(400, "invalid_r2_key");
    return { status: 200, headers: JSON_HEADERS, body: { ok: true } };
  } catch (error) {
    dependencies.onError?.(error, body.source_id);
    return {
      status: 503,
      headers: { ...JSON_HEADERS, "retry-after": "2" },
      body: { ok: false, error: "erasure_index_unavailable" },
    };
  }
}
