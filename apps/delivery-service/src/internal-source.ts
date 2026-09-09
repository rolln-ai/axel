import { timingSafeEqual } from "node:crypto";
import {
  decryptPackedCredential,
  sourceSigningSecretAadString,
  type Source,
  type SourceProvider,
  type SubjectKeyPath,
} from "@axel/shared";

export interface InternalSourceRow {
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
  provider: SourceProvider;
  signing_secret_ciphertext: Buffer | Uint8Array | null;
  signing_secret_previous_ciphertext: Buffer | Uint8Array | null;
  redact_paths: string[] | null;
  ordering_enabled: boolean;
  ordering_key_header: string | null;
  ordering_key_path: string | null;
  subject_key_paths: SubjectKeyPath[] | null;
  inbound_ip_allowlist: string[] | null;
}

export interface SourceLookupPool {
  query<T>(text: string, values: unknown[]): Promise<{ rows: T[] }>;
}

export async function loadInternalSource(
  pool: SourceLookupPool,
  sourceId: string,
  masterKey: Buffer | null,
): Promise<Source | null> {
  const result = await pool.query<InternalSourceRow>(
    `SELECT id::text AS id, workspace_id::text AS workspace_id, name,
            secret_token_hash, url_token_hash, status,
            max_body_bytes, max_body_depth, max_events_per_minute,
            field_selection, provider, signing_secret_ciphertext,
            signing_secret_previous_ciphertext, redact_paths,
            ordering_enabled, ordering_key_header, ordering_key_path,
            subject_key_paths, inbound_ip_allowlist
       FROM sources
      WHERE id = $1
      LIMIT 1`,
    [sourceId],
  );
  const row = result.rows[0];
  return row ? mapInternalSourceRow(row, masterKey) : null;
}

/** Map every edge Source field and fail closed on any encrypted secret. */
export async function mapInternalSourceRow(
  row: InternalSourceRow,
  masterKey: Buffer | null,
): Promise<Source> {
  const decrypt = async (blob: Buffer | Uint8Array | null, label: string): Promise<string | undefined> => {
    if (!blob) return undefined;
    if (!masterKey) {
      throw new Error(`${label} is encrypted but CREDENTIALS_MASTER_KEY is not configured`);
    }
    const plaintext = await decryptSourceSigningSecret(
      masterKey,
      Buffer.from(blob),
      row.workspace_id,
      row.id,
    );
    if (plaintext.length === 0) throw new Error(`${label} decrypted to an empty value`);
    return plaintext;
  };

  const signingSecret = await decrypt(row.signing_secret_ciphertext, "signing secret");
  const signingSecretPrevious = await decrypt(
    row.signing_secret_previous_ciphertext,
    "previous signing secret",
  );

  return {
    source_id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    secret_token: row.secret_token_hash,
    ...(row.url_token_hash ? { url_token_hash: row.url_token_hash } : {}),
    status: row.status,
    ...(row.max_body_bytes !== null ? { max_body_bytes: row.max_body_bytes } : {}),
    ...(row.max_body_depth !== null ? { max_body_depth: row.max_body_depth } : {}),
    ...(row.max_events_per_minute !== null
      ? { max_events_per_minute: row.max_events_per_minute }
      : {}),
    ...(row.field_selection !== null ? { field_selection: row.field_selection } : {}),
    provider: row.provider,
    ...(signingSecret !== undefined ? { signing_secret: signingSecret } : {}),
    ...(signingSecretPrevious !== undefined
      ? { signing_secret_previous: signingSecretPrevious }
      : {}),
    ...((row.redact_paths?.length ?? 0) > 0 ? { redact_paths: row.redact_paths! } : {}),
    ...(row.ordering_enabled
      ? {
          ordering_enabled: true,
          ...(row.ordering_key_header ? { ordering_key_header: row.ordering_key_header } : {}),
          ...(row.ordering_key_path ? { ordering_key_path: row.ordering_key_path } : {}),
        }
      : {}),
    ...((row.subject_key_paths?.length ?? 0) > 0
      ? { subject_key_paths: row.subject_key_paths! }
      : {}),
    ...((row.inbound_ip_allowlist?.length ?? 0) > 0
      ? { inbound_ip_allowlist: row.inbound_ip_allowlist! }
      : {}),
  };
}

/**
 * Decrypt dashboard source-secret blobs via the shared AES-256-GCM core
 * (@axel/shared credential-crypto — golden-vector pinned). Current v2 blobs
 * are AAD-bound to (workspace, source); legacy v1 blobs remain readable, and
 * a v1 nonce that coincidentally begins 0x02 falls back correctly.
 */
export function decryptSourceSigningSecret(
  masterKey: Buffer,
  blob: Buffer,
  workspaceId: string,
  sourceId: string,
): Promise<string> {
  return decryptPackedCredential(blob, masterKey, sourceSigningSecretAadString(workspaceId, sourceId));
}

export interface InternalSourceRequest {
  providedSecret: string | string[] | undefined;
  readBody(): Promise<string>;
}

export interface InternalSourceDependencies {
  sharedSecret: string;
  previousSharedSecret?: string;
  lookupSource(sourceId: string): Promise<Source | null>;
  onError?(error: unknown, sourceId: string | undefined): void;
}

export interface InternalSourceAuthEnv {
  DELIVERY_SHARED_SECRET?: string;
  DELIVERY_SHARED_SECRET_PREVIOUS?: string;
  SOURCE_LOOKUP_SHARED_SECRET?: string;
  SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS?: string;
}

export interface InternalSourceAuthSecrets {
  current: string;
  previous: string;
  usingDeliveryFallback: boolean;
}

export interface DeliveryAuthSecrets {
  current: string;
  previous: string;
}

export function resolveDeliveryAuthSecrets(
  env: Pick<
    InternalSourceAuthEnv,
    "DELIVERY_SHARED_SECRET" | "DELIVERY_SHARED_SECRET_PREVIOUS"
  >,
): DeliveryAuthSecrets {
  return {
    current: env.DELIVERY_SHARED_SECRET ?? "",
    previous: env.DELIVERY_SHARED_SECRET_PREVIOUS ?? "",
  };
}

/**
 * Resolve source-lookup auth independently from the broader delivery-service
 * credential. The DELIVERY_SHARED_SECRET fallback is bootstrap-only: once a
 * dedicated current secret is configured, the delivery credential is no
 * longer accepted unless an operator explicitly places it in the temporary
 * previous slot for a zero-downtime cutover.
 */
export function resolveInternalSourceAuthSecrets(
  env: InternalSourceAuthEnv,
): InternalSourceAuthSecrets {
  const dedicated = env.SOURCE_LOOKUP_SHARED_SECRET ?? "";
  const delivery = resolveDeliveryAuthSecrets(env);
  return {
    current: dedicated || delivery.current,
    previous: env.SOURCE_LOOKUP_SHARED_SECRET_PREVIOUS
      ?? (dedicated ? "" : delivery.previous),
    usingDeliveryFallback: !dedicated,
  };
}

export interface InternalSourceHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: { source: Source | null } | { ok: false; error: string };
}

/** Testable core of POST /internal/source. */
export async function handleInternalSourceRequest(
  request: InternalSourceRequest,
  dependencies: InternalSourceDependencies,
): Promise<InternalSourceHttpResponse> {
  const jsonHeaders = {
    "content-type": "application/json",
    "cache-control": "no-store",
  };
  const currentAuthorized = isInternalSecretAuthorized(
    request.providedSecret,
    dependencies.sharedSecret,
  );
  const previousAuthorized = isInternalSecretAuthorized(
    request.providedSecret,
    dependencies.previousSharedSecret ?? "",
  );
  if (!currentAuthorized && !previousAuthorized) {
    return {
      status: 401,
      headers: jsonHeaders,
      body: { ok: false, error: "unauthorized" },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.readBody());
  } catch {
    return {
      status: 400,
      headers: jsonHeaders,
      body: { ok: false, error: "invalid_body" },
    };
  }
  const sourceId = parsed && typeof parsed === "object"
    && typeof (parsed as { source_id?: unknown }).source_id === "string"
    ? (parsed as { source_id: string }).source_id.trim()
    : "";
  if (!sourceId) {
    return {
      status: 400,
      headers: jsonHeaders,
      body: { ok: false, error: "missing_source_id" },
    };
  }

  try {
    return {
      status: 200,
      headers: jsonHeaders,
      body: { source: await dependencies.lookupSource(sourceId) },
    };
  } catch (error) {
    dependencies.onError?.(error, sourceId);
    return {
      status: 503,
      headers: { ...jsonHeaders, "retry-after": "2" },
      // Never serialize database, key, ciphertext, or crypto error details.
      body: { ok: false, error: "source_lookup_unavailable" },
    };
  }
}

export function isInternalSecretAuthorized(
  provided: string | string[] | undefined,
  expected: string,
): boolean {
  if (!expected || typeof provided !== "string") return false;
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length
    && timingSafeEqual(providedBytes, expectedBytes);
}

export function isRotatingInternalSecretAuthorized(
  provided: string | string[] | undefined,
  secrets: DeliveryAuthSecrets,
): boolean {
  return isInternalSecretAuthorized(provided, secrets.current)
    || isInternalSecretAuthorized(provided, secrets.previous);
}
