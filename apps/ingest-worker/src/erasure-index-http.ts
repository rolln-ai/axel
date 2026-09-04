import {
  readBoundedJsonResponse,
  resolveInternalServiceEndpoint,
} from "@axel/shared";

const ERASURE_INDEX_TIMEOUT_MS = 5_000;
const ERASURE_INDEX_RESPONSE_MAX_BYTES = 64 * 1024;

export interface DeliveryErasureIndexEnv {
  DELIVERY_SERVICE_URL?: string;
  SOURCE_LOOKUP_SHARED_SECRET?: string;
  DELIVERY_SHARED_SECRET?: string;
}

export type ErasureIndexFetch = (
  input: string,
  init: RequestInit,
) => Promise<Response>;

export class ErasureIndexUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErasureIndexUnavailableError";
  }
}

/**
 * Send the pseudonymous subject index to the delivery service, which owns the
 * production Postgres connection. The ingest Worker never receives a database
 * credential in production.
 */
export async function indexErasureSubjectsFromDeliveryService(
  env: DeliveryErasureIndexEnv,
  sourceId: string,
  subjectIds: string[],
  eventId: string,
  r2Key: string,
  receivedAt: string,
  fetchImpl: ErasureIndexFetch = fetch,
): Promise<void> {
  if (subjectIds.length === 0) return;
  const sharedSecret = env.SOURCE_LOOKUP_SHARED_SECRET || env.DELIVERY_SHARED_SECRET;
  if (!env.DELIVERY_SERVICE_URL || !sharedSecret) {
    throw new ErasureIndexUnavailableError(
      "delivery-service erasure index is not configured",
    );
  }
  let endpoint: string;
  try {
    endpoint = resolveInternalServiceEndpoint(
      env.DELIVERY_SERVICE_URL,
      "/internal/erasure-subjects",
    );
  } catch {
    throw new ErasureIndexUnavailableError(
      "delivery-service erasure index is not configured",
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ERASURE_INDEX_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(
      endpoint,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-axel-shared-secret": sharedSecret,
        },
        body: JSON.stringify({
          source_id: sourceId,
          subject_ids: subjectIds,
          event_id: eventId,
          r2_key: r2Key,
          received_at: receivedAt,
        }),
        signal: controller.signal,
      },
    );
  } catch {
    throw new ErasureIndexUnavailableError(
      "delivery-service erasure index request failed",
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ErasureIndexUnavailableError(
      `delivery-service erasure index returned HTTP ${response.status}`,
    );
  }

  let payload: unknown;
  try {
    payload = await readBoundedJsonResponse(response, ERASURE_INDEX_RESPONSE_MAX_BYTES);
  } catch {
    throw new ErasureIndexUnavailableError(
      "delivery-service erasure index returned invalid JSON",
    );
  }
  if (
    !payload
    || typeof payload !== "object"
    || (payload as { ok?: unknown }).ok !== true
  ) {
    throw new ErasureIndexUnavailableError(
      "delivery-service erasure index returned an invalid payload",
    );
  }
}
