import postgres from "postgres";
import {
  decryptPackedCredential,
  deriveFlexibleMasterKey,
  sourceSigningSecretAadString,
  type Source,
  type SubjectKeyPath,
} from "@axel/shared";
import { SourceLookupUnavailableError } from "./source-lookup-error.js";

export { SourceLookupUnavailableError } from "./source-lookup-error.js";

/**
 * Local-development Postgres fallback for source resolution.
 *
 * Older releases treated a KV miss as an unknown source, which could 404 a
 * live source and drop its webhook without a dead-letter row. Current local
 * development calls this lookup directly. Hosted ingest uses delivery service
 * through the source authority.
 *
 * Production no longer uses this path: direct Cloudflare→Postgres connections
 * proved unreliable, so cache misses resolve through delivery-service's
 * authenticated `/internal/source` endpoint. This implementation remains for
 * engineers deliberately running DEV_MODE against a local control plane. The
 * erasure-index writer here is also local-development only.
 */

export interface SourceLookupEnv {
  DATABASE_URL?: string;
  CREDENTIALS_MASTER_KEY?: string;
}

interface SourceRow {
  id: string;
  workspace_id: string;
  name: string;
  secret_token_hash: string;
  url_token_hash: string | null;
  status: "active" | "disabled";
  max_body_bytes: number | null;
  max_body_depth: number | null;
  max_events_per_minute: number | null;
  field_selection: string[] | null;
  provider: string;
  signing_secret_ciphertext: Uint8Array | null;
  signing_secret_previous_ciphertext: Uint8Array | null;
  redact_paths: string[] | null;
  ordering_enabled: boolean;
  ordering_key_header: string | null;
  ordering_key_path: string | null;
  subject_key_paths: SubjectKeyPath[] | null;
  inbound_ip_allowlist: string[] | null;
}

function createSql(connectionString: string): ReturnType<typeof postgres> {
  return postgres(connectionString, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    ssl: connectionString.includes("localhost") ? false : "require",
    // Pooler-safe (see delivery-edge): prepared statements break under a
    // transaction-mode pooler ("prepared statement does not exist").
    prepare: false,
  });
}

async function closeSql(sql: ReturnType<typeof postgres>): Promise<void> {
  try {
    await sql.end({ timeout: 1 });
  } catch {
    console.warn("[ingest] postgres client close failed");
  }
}

/**
 * Write the GDPR erasure index for one event: one row per (subject_id, event_id)
 * into erasure_subjects in local development. Production sends the same
 * pseudonymous index to delivery-service and never gives this Worker a
 * database credential. ON CONFLICT DO NOTHING keeps retries idempotent.
 */
export async function indexErasureSubjects(
  env: SourceLookupEnv,
  workspaceId: string,
  subjectIds: string[],
  eventId: string,
  r2Key: string,
  receivedAt: string,
): Promise<void> {
  if (!env.DATABASE_URL || subjectIds.length === 0) return;
  const sql = createSql(env.DATABASE_URL);
  try {
    const rows = subjectIds.map((subject_id) => ({
      workspace_id: workspaceId,
      subject_id,
      event_id: eventId,
      r2_key: r2Key,
      received_at: receivedAt,
    }));
    await sql`
      INSERT INTO erasure_subjects ${sql(rows, "workspace_id", "subject_id", "event_id", "r2_key", "received_at")}
      ON CONFLICT (workspace_id, subject_id, event_id) DO NOTHING
    `;
  } finally {
    await closeSql(sql);
  }
}

/**
 * Resolve a source directly from local-development Postgres. Returns null when
 * there is no binding or the source genuinely does not exist; throws
 * SourceLookupUnavailableError when Postgres itself is unreachable.
 */
export async function lookupSourceInPostgres(env: SourceLookupEnv, sourceId: string): Promise<Source | null> {
  if (!env.DATABASE_URL) return null; // no control-plane binding → no fallback (local dev)
  let rows: SourceRow[];
  const sql = createSql(env.DATABASE_URL);
  try {
    rows = (await sql<SourceRow[]>`
      SELECT id, workspace_id, name, secret_token_hash, url_token_hash, status,
             max_body_bytes, max_body_depth, max_events_per_minute,
             field_selection,
             provider, signing_secret_ciphertext, signing_secret_previous_ciphertext,
             redact_paths, ordering_enabled, ordering_key_header, ordering_key_path,
             subject_key_paths, inbound_ip_allowlist
        FROM sources
       WHERE id = ${sourceId}
       LIMIT 1
    `) as unknown as SourceRow[];
  } catch (err) {
    // Do not turn a database failure into an unknown source. Signal a transient
    // failure so the handler returns 503 and the producer retries.
    throw new SourceLookupUnavailableError(
      `source lookup failed for ${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await closeSql(sql);
  }
  const row = rows[0];
  if (!row) return null; // genuinely unknown source — a legitimate negative.
  return mapSourceRow(row, env.CREDENTIALS_MASTER_KEY);
}

/**
 * Map a `sources` row to the edge `Source` shape. This matches the dashboard's
 * rowToEdgePayload. `secret_token` holds the hash and `signing_secret` is the
 * decrypted ciphertext value.
 */
export async function mapSourceRow(row: SourceRow, masterKeyRaw: string | undefined): Promise<Source> {
  // Decrypt both rotation slots before constructing the Source. The presence of
  // either ciphertext means signature verification was configured; omitting a
  // failed slot would silently turn a custom-HMAC source into token-only auth or
  // leave a named provider accepting only the previous secret.
  const decrypt = async (blob: Uint8Array | null): Promise<string | undefined> => {
    if (!blob || !masterKeyRaw) return undefined;
    try {
      return await decryptSourceSigningSecretEdge(masterKeyRaw, toBytes(blob), row.workspace_id, row.id);
    } catch {
      console.error("[ingest] decrypt signing secret failed");
      return undefined;
    }
  };
  const signingSecret = await decrypt(row.signing_secret_ciphertext);
  const signingSecretPrevious = await decrypt(row.signing_secret_previous_ciphertext);
  // FAIL CLOSED on every configured slot, including an empty plaintext. Signal
  // transient so ingest 503s and the producer retries until the key/blob is
  // repaired rather than caching an authentication downgrade.
  if (row.signing_secret_ciphertext && !signingSecret) {
    throw new SourceLookupUnavailableError(
      `current signing secret present but undecryptable for source ${row.id} — refusing to skip verification (CREDENTIALS_MASTER_KEY missing or corrupt)`,
    );
  }
  if (row.signing_secret_previous_ciphertext && !signingSecretPrevious) {
    throw new SourceLookupUnavailableError(
      `previous signing secret present but undecryptable for source ${row.id} — refusing to skip verification (CREDENTIALS_MASTER_KEY missing or corrupt)`,
    );
  }
  const source: Source = {
    source_id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    secret_token: row.secret_token_hash,
    ...(row.url_token_hash ? { url_token_hash: row.url_token_hash } : {}),
    status: row.status,
    ...(row.max_body_bytes != null ? { max_body_bytes: row.max_body_bytes } : {}),
    ...(row.max_body_depth != null ? { max_body_depth: row.max_body_depth } : {}),
    ...(row.max_events_per_minute != null ? { max_events_per_minute: row.max_events_per_minute } : {}),
    ...(row.field_selection !== null ? { field_selection: row.field_selection } : {}),
    provider: row.provider as NonNullable<Source["provider"]>,
    ...(signingSecret ? { signing_secret: signingSecret } : {}),
    // Full hot-path field set — same fix as rowToEdgePayload (redaction /
    // rotation overlap / ordering were inert on the fallback path too).
    ...(signingSecretPrevious ? { signing_secret_previous: signingSecretPrevious } : {}),
    ...((row.redact_paths?.length ?? 0) > 0 ? { redact_paths: row.redact_paths as string[] } : {}),
    ...(row.ordering_enabled
      ? {
          ordering_enabled: true,
          ...(row.ordering_key_header ? { ordering_key_header: row.ordering_key_header } : {}),
          ...(row.ordering_key_path ? { ordering_key_path: row.ordering_key_path } : {}),
        }
      : {}),
    ...((row.subject_key_paths?.length ?? 0) > 0
      ? { subject_key_paths: row.subject_key_paths as SubjectKeyPath[] }
      : {}),
    ...((row.inbound_ip_allowlist?.length ?? 0) > 0
      ? { inbound_ip_allowlist: row.inbound_ip_allowlist as string[] }
      : {}),
  };
  return source;
}

const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * Decrypt the dashboard's source signing-secret blob via the shared
 * AES-256-GCM core (@axel/shared credential-crypto — golden-vector pinned).
 * Handles both packed layouts (v2 `[0x02|nonce|ct|tag]` AAD-bound and legacy
 * v1 `[nonce|ct|tag]`) and the flexible hex/base64/sha256 master-key forms
 * this runtime has always accepted.
 */
export async function decryptSourceSigningSecretEdge(
  masterKeyRaw: string,
  blob: Uint8Array,
  workspaceId: string,
  sourceId: string,
): Promise<string> {
  if (blob.length < NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error("source signing secret blob is too short to be valid");
  }
  const keyBytes = await deriveFlexibleMasterKey(masterKeyRaw);
  return decryptPackedCredential(blob, keyBytes, sourceSigningSecretAadString(workspaceId, sourceId));
}

function toBytes(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // postgres.js may hand a bytea back as a Buffer-like {type:"Buffer",data:[…]}.
  const data = (v as { data?: number[] } | null)?.data;
  if (Array.isArray(data)) return Uint8Array.from(data);
  return new Uint8Array(0);
}
