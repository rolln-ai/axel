import {
  readBoundedJsonResponse,
  resolveInternalServiceEndpoint,
  type Source,
  type SubjectKeyPath,
} from "@axel/shared";
import { SourceLookupUnavailableError } from "./source-lookup-error.js";

const SOURCE_LOOKUP_TIMEOUT_MS = 5_000;
const SOURCE_LOOKUP_RESPONSE_MAX_BYTES = 1024 * 1024;

export interface DeliverySourceLookupEnv {
  DELIVERY_SERVICE_URL?: string;
  SOURCE_LOOKUP_SHARED_SECRET?: string;
  /** Bootstrap fallback and heartbeat credential; source lookup prefers the
   * dedicated secret whenever it is configured. */
  DELIVERY_SHARED_SECRET?: string;
}

export type SourceLookupFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

/**
 * Resolve a source through delivery-service, which owns the reliable Postgres
 * connection and signing-secret decryption. Every upstream/protocol failure is
 * transient; only an explicit `{ source: null }` is a genuine miss.
 */
export async function lookupSourceFromDeliveryService(
  env: DeliverySourceLookupEnv,
  sourceId: string,
  fetchImpl: SourceLookupFetch = fetch,
): Promise<Source | null> {
  const sharedSecret = env.SOURCE_LOOKUP_SHARED_SECRET || env.DELIVERY_SHARED_SECRET;
  if (!env.DELIVERY_SERVICE_URL || !sharedSecret) {
    throw new SourceLookupUnavailableError("delivery-service source lookup is not configured");
  }
  let endpoint: string;
  try {
    endpoint = resolveInternalServiceEndpoint(
      env.DELIVERY_SERVICE_URL,
      "/internal/source",
    );
  } catch {
    throw new SourceLookupUnavailableError("delivery-service source lookup is not configured");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_LOOKUP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "x-axel-shared-secret": sharedSecret,
      },
      body: JSON.stringify({ source_id: sourceId }),
      signal: controller.signal,
    });
  } catch {
    throw new SourceLookupUnavailableError("delivery-service source lookup request failed");
  } finally {
    clearTimeout(timer);
  }

  // A 404 can mean an older delivery deployment without this endpoint, so it
  // must not be interpreted as an unknown source. Only a validated 200 body can
  // produce a cacheable miss.
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new SourceLookupUnavailableError(
      `delivery-service source lookup returned HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await readBoundedJsonResponse(response, SOURCE_LOOKUP_RESPONSE_MAX_BYTES);
  } catch {
    throw new SourceLookupUnavailableError("delivery-service source lookup returned invalid JSON");
  }
  if (!payload || typeof payload !== "object" || !("source" in payload)) {
    throw new SourceLookupUnavailableError("delivery-service source lookup returned an invalid payload");
  }
  const source = (payload as { source: unknown }).source;
  if (source === null) return null;
  if (!isSource(source) || source.source_id !== sourceId) {
    throw new SourceLookupUnavailableError("delivery-service source lookup returned an invalid source");
  }
  return source;
}

function isSource(value: unknown): value is Source {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.source_id === "string"
    && typeof source.workspace_id === "string"
    && typeof source.name === "string"
    && typeof source.secret_token === "string"
    && (source.url_token_hash === undefined
      || (typeof source.url_token_hash === "string" && /^[0-9a-f]{64}$/.test(source.url_token_hash)))
    && (source.status === "active" || source.status === "disabled")
    && optionalNumber(source.max_body_bytes)
    && optionalNumber(source.max_body_depth)
    && optionalNumber(source.max_events_per_minute)
    && optionalProvider(source.provider)
    && optionalString(source.signing_secret)
    && optionalString(source.signing_secret_previous)
    && optionalStringArray(source.redact_paths)
    && optionalBoolean(source.ordering_enabled)
    && optionalString(source.ordering_key_header)
    && optionalString(source.ordering_key_path)
    && optionalSubjectKeyPaths(source.subject_key_paths)
    && optionalStringArray(source.inbound_ip_allowlist)
    && optionalNullableStringArray(source.field_selection)
  );
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function optionalProvider(value: unknown): boolean {
  return value === undefined
    || value === "custom"
    || value === "stripe"
    || value === "github"
    || value === "shopify"
    || value === "chargebee";
}

function optionalStringArray(value: unknown): boolean {
  return value === undefined
    || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function optionalNullableStringArray(value: unknown): boolean {
  return value === null || optionalStringArray(value);
}

function optionalSubjectKeyPaths(value: unknown): boolean {
  return value === undefined
    || value === null
    || (Array.isArray(value) && value.every(isSubjectKeyPath));
}

function isSubjectKeyPath(value: unknown): value is SubjectKeyPath {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const path = value as Record<string, unknown>;
  return (
    (path.loc === "body" || path.loc === "header" || path.loc === "query")
    && typeof path.path === "string"
    && (path.kind === undefined || typeof path.kind === "string")
  );
}
