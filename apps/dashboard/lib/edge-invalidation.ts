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
 *   - `pushSourceToEdge(source)`     — write current state into KV (24h TTL)
 *   - `invalidateEdgeSourceCache()`  — drop the cached entry by source_id
 *
 * Required env:
 *   - INGEST_ADMIN_URL   — base ingest URL, e.g. https://ingest.axelapp.ai
 *                          (we derive /admin/source-cache/{put,invalidate})
 *   - INGEST_ADMIN_TOKEN — must match the ingest worker's ADMIN_TOKEN binding
 *
 * Both unset = no-op. Useful in dev when there's no edge to sync.
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
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        "x-axel-admin-token": token,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok && res.status !== 204) {
      const text = await res.text().catch(() => "");
      console.error(`[edge] non-2xx ${res.status} for ${url}: ${text.slice(0, 200)}`);
      // A failed push leaves the source un-routable in KV until TTL/next-push —
      // surface it to Sentry instead of only console (audit observability gap).
      await reportEdgeSyncFailure(
        options,
        new Error(`edge admin POST ${res.status}: ${text.slice(0, 200)}`),
        url,
        String(res.status),
      );
    }
  } catch (err) {
    // Cache will self-heal via TTL — never let cache errors break the user's
    // action in the dashboard. But DO report it: a swallowed push failure is
    // exactly how a source silently stops being routable.
    console.error(`[edge] POST failed for ${url}:`, err);
    await reportEdgeSyncFailure(options, err, url);
  } finally {
    clearTimeout(timer);
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
  await adminPost(urls.invalidate, { source_id: sourceId }, token, options);
}

/**
 * Push the current state of a source to the edge cache. Called from the
 * dashboard on createSource / setSourceStatus / rotateSourceToken so
 * worker lookups see the latest config without waiting for a TTL.
 *
 * The worker validates the source shape strictly — if the worker rejects it
 * (400 invalid_source_shape), we log and move on rather than failing the
 * dashboard action; the cache remains in its prior state and the worker
 * falls through to its dev-mode lookup.
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
  // Decrypt the at-rest signing secret so the edge worker has the
  // plaintext it needs to verify HMACs. Best-effort: if decryption
  // fails (e.g. master key rotated mid-rollout) the provider
  // verification will see "missing_secret" and reject — same end-state
  // as if the operator had never set a secret, never silently passes.
  // Decrypt the current + previous signing secrets so the edge worker has the
  // plaintext it needs to verify HMACs (and to keep verifying during a rotation
  // overlap window). Best-effort: on decrypt failure the provider verification
  // sees "missing_secret" and rejects — same end-state as no secret, never a
  // silent pass.
  const decryptOrUndefined = async (blob: Buffer | null): Promise<string | undefined> => {
    if (!blob) return undefined;
    try {
      return await decryptSourceSigningSecret(blob, row.workspace_id, row.id);
    } catch (err) {
      console.error(`[edge] decrypt signing secret failed for source ${row.id}:`, err);
      return undefined;
    }
  };
  const signingSecret = await decryptOrUndefined(row.signing_secret_ciphertext);
  const signingSecretPrevious = await decryptOrUndefined(row.signing_secret_previous_ciphertext);
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
