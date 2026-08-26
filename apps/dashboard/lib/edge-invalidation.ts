import "server-only";
import type { SourceProvider, SubjectKeyPath } from "@axel/shared";
import { db } from "./db";
import { decryptSourceSigningSecret } from "./source-secret";
import { captureDashboardException } from "./sentry-capture";

/**
 * Edge cache helpers — keep KV-backed worker source lookups in sync with the
 * Postgres control plane.
 *
 * The dashboard mutates sources (create / disable / rotate token / delete) in
 * Postgres, but the ingest worker reads source config from a KV cache at the
 * edge. Two helpers bridge the gap:
 *
 *   - `pushSourceToEdge(source)`     — write current state into KV (5m TTL)
 *   - `invalidateEdgeSourceCache()`  — drop the cached entry by source_id
 *
 * Required env:
 *   - INGEST_ADMIN_URL   — base ingest URL, e.g. https://ingest.axelapp.ai
 *                          (we derive /admin/source-cache/{put,invalidate})
 *   - INGEST_ADMIN_TOKEN — must match the ingest worker's ADMIN_TOKEN binding
 *
 * Best-effort helpers are a no-op when these values are unset, which is useful
 * in dev when there is no edge to sync. Auth-sensitive mutations use
 * `requireEdgeSourceCacheInvalidation`, which fails closed instead.
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
   * decrypts the at-rest ciphertext server-side and pushes plaintext
   * over the HTTPS admin channel to the worker, which stores it in KV
   * for hot-path verification. Token is the same INGEST_ADMIN_TOKEN
   * that already protects this endpoint.
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

function endpointUrls(env: Record<string, string | undefined>): { put: string; invalidate: string } | null {
  // Backwards compat: INGEST_ADMIN_URL was originally the full /invalidate path.
  // Derive the put endpoint from the same base if possible.
  const raw = env.INGEST_ADMIN_URL;
  if (!raw) return null;
  // Strip any trailing /admin/source-cache/* if present, then append both paths.
  const base = raw.replace(/\/admin\/source-cache\/(invalidate|put)\/?$/, "").replace(/\/$/, "");
  return {
    put: `${base}/admin/source-cache/put`,
    invalidate: `${base}/admin/source-cache/invalidate`,
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
  } catch (err) {
    console.error(`[edge] POST failed for ${url}:`, err);
    await reportEdgeSyncFailure(options, err, url);
    if (required) {
      throw new Error(`required edge cache POST failed for ${url}`, { cause: err });
    }
    return;
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const responseText = await res.text().catch(() => "");
    const failure = new Error(`edge admin POST ${res.status}: ${responseText.slice(0, 200)}`);
    console.error(`[edge] non-2xx ${res.status} for ${url}: ${responseText.slice(0, 200)}`);
    await reportEdgeSyncFailure(options, failure, url, String(res.status));
    if (required) throw failure;
  }
}

/**
 * Report an edge cache-sync failure through the dashboard Sentry SDK.
 * The adapter swallows its own errors, so this can't break the action.
 */
async function reportEdgeSyncFailure(
  _options: EdgeInvalidationOptions,
  err: unknown,
  url: string,
  httpStatus?: string,
): Promise<void> {
  await captureDashboardException(err, {
    tags: { component: "edge_cache_sync", url, ...(httpStatus ? { http_status: httpStatus } : {}) },
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

/**
 * Delete a source cache entry and prove that the worker accepted the delete.
 * Security-sensitive source mutations call this before and after their
 * Postgres write to narrow stale-credential and stale-policy races. Missing
 * admin configuration, transport failures, and non-2xx responses all reject;
 * the short positive TTL bounds distributed propagation and lookups already
 * in flight after the last delete.
 */
export async function requireEdgeSourceCacheInvalidation(
  sourceId: string,
  options: EdgeInvalidationOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const token = env.INGEST_ADMIN_TOKEN;
  const urls = endpointUrls(env);
  if (!urls || !token) {
    throw new Error("required edge cache invalidation is not configured");
  }
  await adminPost(urls.invalidate, { source_id: sourceId }, token, options, true);
}

/** Required invalidation for a workspace-wide status change, with bounded fan-out. */
export async function requireEdgeSourceCacheInvalidations(
  sourceIds: readonly string[],
  options: EdgeInvalidationOptions = {},
): Promise<void> {
  const concurrency = 10;
  for (let index = 0; index < sourceIds.length; index += concurrency) {
    await Promise.all(
      sourceIds.slice(index, index + concurrency).map((sourceId) => (
        requireEdgeSourceCacheInvalidation(sourceId, options)
      )),
    );
  }
}

/**
 * Push the current state of a newly created source to warm the edge cache.
 * Existing-source auth/privacy mutations invalidate instead, so a failed push
 * can never preserve an older credential or policy.
 *
 * The worker validates the source shape strictly — if the worker rejects it
 * (400 invalid_source_shape), we log and move on rather than failing the
 * dashboard action; the worker falls through to its authenticated source
 * lookup when the cache is empty.
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
    } catch (err) {
      console.error(`[edge] decrypt ${label} signing secret failed for source ${row.id}:`, err);
      throw new Error(
        `${label} signing secret is configured but could not be decrypted for source ${row.id}; refusing to publish an unsigned edge payload`,
        { cause: err },
      );
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
