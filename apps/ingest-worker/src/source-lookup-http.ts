import {
  readBoundedJsonResponse,
  resolveInternalServiceEndpoint,
  type Source,
  type SubjectKeyPath,
} from "@axel/shared";
import { SourceLookupUnavailableError } from "./source-lookup-error.js";

export const SOURCE_LOOKUP_TIMEOUT_MS = 4_500;
const SOURCE_LOOKUP_RETRY_DELAY_MS = 100;
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
    throw new SourceLookupUnavailableError("delivery-service source lookup is not configured", "lookup_not_configured");
  }
  let endpoint: string;
  try {
    endpoint = resolveInternalServiceEndpoint(
      env.DELIVERY_SERVICE_URL,
      "/internal/source",
    );
  } catch {
    throw new SourceLookupUnavailableError("delivery-service source lookup is not configured", "lookup_not_configured");
  }

  // This endpoint only reads configuration. Retry one transient failure using
  // the same authenticated request; never fall back to stale authorization.
  for (let attempt = 0; ; attempt++) {
    try {
      return await requestSource(endpoint, sharedSecret, sourceId, fetchImpl);
    } catch (error) {
      const retryable = error instanceof SourceLookupUnavailableError && (
        error.reason === "lookup_timeout" || error.reason === "lookup_network"
        || (error.reason === "lookup_http" && [408, 500, 502, 503, 504].includes(error.httpStatus ?? 0))
      );
      if (attempt > 0 || !retryable) throw error;
      await new Promise((resolve) => setTimeout(resolve, SOURCE_LOOKUP_RETRY_DELAY_MS));
    }
  }
}

async function requestSource(
  endpoint: string,
  sharedSecret: string,
  sourceId: string,
  fetchImpl: SourceLookupFetch,
): Promise<Source | null> {
  const controller = new AbortController();
  let response: Response | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      void response?.body?.cancel().catch(() => undefined);
      reject(new SourceLookupUnavailableError("delivery-service source lookup timed out", "lookup_timeout"));
    }, SOURCE_LOOKUP_TIMEOUT_MS);
  });
  const work = async (): Promise<Source | null> => {
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
      throw new SourceLookupUnavailableError("delivery-service source lookup request failed", controller.signal.aborted ? "lookup_timeout" : "lookup_network");
    }

    // A 404 can mean an older delivery deployment without this endpoint, so it
    // must not be interpreted as an unknown source. Only a validated 200 body can
    // produce a cacheable miss.
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new SourceLookupUnavailableError(
        `delivery-service source lookup returned HTTP ${response.status}`,
        "lookup_http",
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await readBoundedJsonResponse(response, SOURCE_LOOKUP_RESPONSE_MAX_BYTES);
    } catch {
      throw new SourceLookupUnavailableError("delivery-service source lookup returned invalid JSON", controller.signal.aborted ? "lookup_timeout" : "lookup_invalid_response");
    }
    if (!payload || typeof payload !== "object" || !("source" in payload)) {
      throw new SourceLookupUnavailableError("delivery-service source lookup returned an invalid payload", "lookup_invalid_response");
    }
    const source = (payload as { source: unknown }).source;
    if (source === null) return null;
    if (!isSource(source) || source.source_id !== sourceId) {
      throw new SourceLookupUnavailableError("delivery-service source lookup returned an invalid source", "lookup_invalid_response");
    }
    return source;
  };
  try {
    // Keep the deadline through body consumption, not just response headers.
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer!);
  }
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
