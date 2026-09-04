import "server-only";
import type { SourceProvider, SubjectKeyPath } from "@axel/shared";
import { db } from "./db";
import { decryptSourceSigningSecret } from "./source-secret";
import { captureDashboardException } from "./sentry-capture";

/**
 * Source authorization coordination between the Postgres control plane and
 * the ingest worker. Security-sensitive mutations fence the source first, then
 * publish freshly loaded committed state with the same one-use token. A failed
 * sync leaves the hosted source blocked.
 *
 * Self-host installs omit the Durable Object binding. Their ingest worker does
 * an authenticated delivery-service lookup on every request, so the same admin
 * calls return 204 without introducing a cache.
 */

interface EdgeSource {
  source_id: string;
  workspace_id: string;
  name: string;
  secret_token: string;
  status: "active" | "disabled";
  max_body_bytes?: number;
  max_body_depth?: number;
  max_events_per_minute?: number;
  /**
   * AXE-23 provider preset + plaintext signing secret. The dashboard
   * decrypts the at-rest ciphertext server-side and pushes plaintext over the
   * HTTPS admin channel. The per-source authority retains it only in live
   * memory and persists a digest, never the secret itself. Token is the same
   * INGEST_ADMIN_TOKEN that already protects this endpoint.
   */
  provider?: "custom" | "stripe" | "github" | "shopify" | "chargebee";
  signing_secret?: string;
  field_selection?: string[];
  /**
   * The full hot-path field set. These were historically dropped from the edge
   * payload — propagating them is the fix for inert PII redaction, broken
   * secret-rotation overlap, and ignored ordering at the edge (release audit).
   */
  signing_secret_previous?: string;
  redact_paths?: string[];
  ordering_enabled?: boolean;
  ordering_key_header?: string;
  ordering_key_path?: string;
  subject_key_paths?: SubjectKeyPath[];
  inbound_ip_allowlist?: string[];
}

export interface EdgeInvalidationOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

interface EdgeAdminUrls {
  put: string;
  invalidate: string;
  fence: string;
  sync: string;
}

function endpointUrls(env: Record<string, string | undefined>): EdgeAdminUrls | null {
  // INGEST_ADMIN_URL historically accepted a full cache endpoint. Normalize
  // old and new endpoint forms so existing installations can update in place.
  const raw = env.INGEST_ADMIN_URL;
  if (!raw) return null;
  const base = raw
    .replace(/\/admin\/(?:source-cache\/(?:invalidate|put)|source-authority\/(?:fence|sync))\/?$/, "")
    .replace(/\/$/, "");
  return {
    put: `${base}/admin/source-cache/put`,
    invalidate: `${base}/admin/source-cache/invalidate`,
    fence: `${base}/admin/source-authority/fence`,
    sync: `${base}/admin/source-authority/sync`,
  };
}

async function adminPost(
  url: string,
  body: unknown,
  token: string,
  options: EdgeInvalidationOptions,
  required: boolean,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        "x-axel-admin-token": token,
      },
      body: JSON.stringify(body),
    });
  } catch {
    const failure = new Error("edge_admin_transport_failed");
    console.error("[edge] admin POST transport failed");
    await reportEdgeSyncFailure(options, failure);
    if (required) {
      throw failure;
    }
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const failure = new Error(`edge_admin_http_${res.status}`);
    console.error(`[edge] admin POST returned ${res.status}`);
    await reportEdgeSyncFailure(options, failure, String(res.status));
    if (required) throw failure;
  }
}

/**
 * Report an edge authorization-sync failure through the dashboard Sentry SDK.
 * The adapter swallows its own errors, so this can't break the action.
 */
async function reportEdgeSyncFailure(
  _options: EdgeInvalidationOptions,
  err: unknown,
  httpStatus?: string,
): Promise<void> {
  await captureDashboardException(err, {
    tags: { component: "edge_cache_sync", ...(httpStatus ? { http_status: httpStatus } : {}) },
  });
}

export async function invalidateEdgeSourceCache(
  sourceId: string,
  options: EdgeInvalidationOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const token = env.INGEST_ADMIN_TOKEN;
  const urls = endpointUrls(env);
  if (!urls || !token) return;
  await adminPost(urls.invalidate, { source_id: sourceId }, token, options, false);
}

export interface EdgeSourceFence {
  sourceId: string;
  fenceToken: string;
}

/** Block hosted authorization before changing a source in Postgres. */
export async function requireEdgeSourceFence(
  sourceId: string,
  options: EdgeInvalidationOptions = {},
): Promise<EdgeSourceFence> {
  const env = options.env ?? process.env;
  const token = env.INGEST_ADMIN_TOKEN;
  const urls = endpointUrls(env);
  if (!urls || !token) {
    throw new Error("required edge source authority is not configured");
  }
  const fenceToken = crypto.randomUUID().replaceAll("-", "");
  await adminPost(
    urls.fence,
    { source_id: sourceId, fence_token: fenceToken },
    token,
    options,
    true,
  );
  return { sourceId, fenceToken };
}

/** Fence a workspace's sources with bounded fan-out. */
export async function requireEdgeSourceFences(
  sourceIds: readonly string[],
  options: EdgeInvalidationOptions = {},
): Promise<EdgeSourceFence[]> {
  const concurrency = 10;
  const fences: EdgeSourceFence[] = [];
  for (let index = 0; index < sourceIds.length; index += concurrency) {
    fences.push(...await Promise.all(
      sourceIds.slice(index, index + concurrency).map((sourceId) => (
        requireEdgeSourceFence(sourceId, options)
      )),
    ));
  }
  return fences;
}

/** Publish committed source state and release its matching fence. */
export async function requireEdgeSourceAuthoritySync(
  fence: EdgeSourceFence,
  workspaceId: string,
  options: EdgeInvalidationOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const token = env.INGEST_ADMIN_TOKEN;
  const urls = endpointUrls(env);
  if (!urls || !token) {
    throw new Error("required edge source authority is not configured");
  }

  const row = await loadSourceForEdge(fence.sourceId, workspaceId);
  const source = row ? await rowToEdgePayload(row) : null;
  await adminPost(
    urls.sync,
    {
      source_id: fence.sourceId,
      fence_token: fence.fenceToken,
      source,
    },
    token,
    options,
    true,
  );
}

/** Sync a workspace's committed source state with bounded fan-out. */
export async function requireEdgeSourceAuthoritySyncs(
  fences: readonly EdgeSourceFence[],
  workspaceId: string,
  options: EdgeInvalidationOptions = {},
): Promise<void> {
  const concurrency = 10;
  for (let index = 0; index < fences.length; index += concurrency) {
    await Promise.all(
      fences.slice(index, index + concurrency).map((fence) => (
        requireEdgeSourceAuthoritySync(fence, workspaceId, options)
      )),
    );
  }
}

/**
 * Push a newly created source as an optional cold-start warm-up. The Durable
 * Object accepts bootstrap only before it has any state, so this best-effort
 * call cannot overwrite an existing credential or a mutation fence.
 *
 * The worker validates the source shape strictly — if the worker rejects it
 * (400 invalid_source_shape), we log and move on rather than failing the
 * dashboard action. A cold object falls through to authenticated origin lookup.
 */
export async function pushSourceToEdge(
  source: EdgeSource,
  options: EdgeInvalidationOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const token = env.INGEST_ADMIN_TOKEN;
  const urls = endpointUrls(env);
  if (!urls || !token) return;
  await adminPost(
    urls.put,
    { source_id: source.source_id, source },
    token,
    options,
    false,
  );
}

export interface SourceDbRow {
  id: string;
  workspace_id: string;
  name: string;
  secret_token_hash: string;
  status: "active" | "disabled";
  max_body_bytes: number | null;
  max_body_depth: number | null;
  max_events_per_minute: number | null;
  field_selection: string[] | null;
  // AXE-23: per-provider signature verification metadata.
  provider: SourceProvider;
  signing_secret_ciphertext: Buffer | null;
  // Rotation overlap: previous signing secret, kept until the old one is retired.
  signing_secret_previous_ciphertext: Buffer | null;
  // PII redaction dot-paths applied at ingest before the R2 write.
  redact_paths: string[] | null;
  // FIFO / ordered delivery.
  ordering_enabled: boolean;
  ordering_key_header: string | null;
  ordering_key_path: string | null;
  // GDPR per-subject erasure: operator-configured subject-id paths.
  subject_key_paths: SubjectKeyPath[] | null;
  // AXE-34: inbound IP allowlist (CIDRs). Empty = accept any IP.
  inbound_ip_allowlist: string[];
}

export async function loadSourceForEdge(sourceId: string, workspaceId: string): Promise<SourceDbRow | null> {
  const result = await db().query<SourceDbRow>(
    `SELECT id, workspace_id, name, secret_token_hash, status,
            max_body_bytes, max_body_depth, max_events_per_minute, field_selection,
            provider, signing_secret_ciphertext, signing_secret_previous_ciphertext,
            redact_paths, ordering_enabled, ordering_key_header, ordering_key_path,
            subject_key_paths, inbound_ip_allowlist
       FROM sources
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [sourceId, workspaceId],
  );
  return result.rows[0] ?? null;
}

export async function rowToEdgePayload(row: SourceDbRow, overrides: Partial<{ secretTokenHash: string }> = {}) {
  // Decrypt the current + previous signing secrets so the edge worker has the
  // plaintext it needs to verify HMACs (and to keep verifying during a rotation
  // overlap window). A configured ciphertext is also the durable signal that
  // signature verification is required. Never erase that signal by publishing
  // a payload with an omitted secret: custom-HMAC sources would become
  // token-only, and a partially decrypted rotation could keep accepting only
  // the previous secret. Refuse the cache update instead.
  const decryptConfiguredSecret = async (
    blob: Buffer | null,
    label: "current" | "previous",
  ): Promise<string | undefined> => {
    if (!blob) return undefined;
    try {
      const plaintext = await decryptSourceSigningSecret(blob, row.workspace_id, row.id);
      if (plaintext.length === 0) {
        throw new Error(`${label} signing secret decrypted to an empty value`);
      }
      return plaintext;
    } catch {
      console.error(`[edge] decrypt ${label} signing secret failed`);
      throw new Error(`${label}_signing_secret_decrypt_failed`);
    }
  };
  const signingSecret = await decryptConfiguredSecret(row.signing_secret_ciphertext, "current");
  const signingSecretPrevious = await decryptConfiguredSecret(
    row.signing_secret_previous_ciphertext,
    "previous",
  );
  return {
    source_id: row.id,
    workspace_id: row.workspace_id,
    name: row.name,
    secret_token: overrides.secretTokenHash ?? row.secret_token_hash,
    status: row.status,
    ...(row.max_body_bytes !== null ? { max_body_bytes: row.max_body_bytes } : {}),
    ...(row.max_body_depth !== null ? { max_body_depth: row.max_body_depth } : {}),
    ...(row.max_events_per_minute !== null ? { max_events_per_minute: row.max_events_per_minute } : {}),
    ...(row.field_selection ? { field_selection: row.field_selection } : {}),
    provider: row.provider,
    ...(signingSecret ? { signing_secret: signingSecret } : {}),
    // CRITICAL (audit): these were dropped here, so PII redaction was inert,
    // secret-rotation overlap broke (401 outage), and ordering was ignored at
    // the edge. Propagate the full field set the hot path reads.
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
      ? { inbound_ip_allowlist: row.inbound_ip_allowlist }
      : {}),
  } as const;
}
