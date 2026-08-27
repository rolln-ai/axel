import type {
  DestinationQueueMessage,
  RouteDestinationBinding,
} from "@axel/shared";

export const DESTINATION_QUEUE_MESSAGE_VERSION = 1 as const;

export interface PulledMessage {
  body: unknown;
  lease_id: string;
  id: string;
  attempts?: number;
  timestamp_ms?: number;
  metadata?: {
    CF_QUEUE_NAME?: string;
    "CF-Content-Type"?: string;
    [key: string]: unknown;
  };
}

export class PulledBatchContractError extends Error {
  constructor() {
    super("cloudflare_pull_response_contract_invalid");
    this.name = "PulledBatchContractError";
  }
}

export type PulledMessageFailureCode =
  | "unsupported_content_type"
  | "invalid_base64"
  | "invalid_json"
  | "body_not_object"
  | "unsupported_version"
  | "missing_field"
  | "invalid_field";

export type DestinationQueueMessageValidation =
  | {
      ok: true;
      message: DestinationQueueMessage;
      /** Version observed on the wire. Legacy messages omit the field. */
      wireVersion: 0 | typeof DESTINATION_QUEUE_MESSAGE_VERSION;
    }
  | {
      ok: false;
      code: PulledMessageFailureCode;
      /** Field name only. Never includes a field value or payload excerpt. */
      field?: string;
    };

interface DecodedBodySuccess {
  ok: true;
  value: unknown;
}

interface DecodedBodyFailure {
  ok: false;
  code: Extract<
    PulledMessageFailureCode,
    "unsupported_content_type" | "invalid_base64" | "invalid_json"
  >;
}

const REQUIRED_STRING_FIELDS = [
  "event_id",
  "workspace_id",
  "source_id",
  "route_id",
  "destination_id",
  "r2_key",
  "received_at",
  "enqueued_at",
  "idempotency_key",
  "content_type",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string): DecodedBodySuccess | DecodedBodyFailure {
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false, code: "invalid_json" };
  }
}

function decodeBase64Utf8(value: string): string | null {
  // Cloudflare documents RFC 4648 base64. Check the alphabet and canonical
  // round trip because Buffer.from otherwise discards invalid characters.
  if (
    value.length === 0
    || value.length % 4 === 1
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64");
  const withoutPadding = (input: string) => input.replace(/=+$/, "");
  if (withoutPadding(decoded.toString("base64")) !== withoutPadding(value)) {
    return null;
  }
  return decoded.toString("utf8");
}

function decodeUnencodedBody(raw: unknown): DecodedBodySuccess | DecodedBodyFailure {
  if (typeof raw === "string") return parseJson(raw);
  if (!isRecord(raw)) return { ok: true, value: raw };

  // Retain compatibility with an early pull-client wrapper. This is decoding,
  // not validation. The unwrapped value still has to pass the v0/v1 contract.
  if ("body" in raw && Object.keys(raw).length === 1) {
    return decodeUnencodedBody(raw.body);
  }
  return { ok: true, value: raw };
}

function decodePulledMessageBody(
  message: Pick<PulledMessage, "body" | "metadata">,
): DecodedBodySuccess | DecodedBodyFailure {
  const contentType = message.metadata?.["CF-Content-Type"];

  if (contentType === "json") {
    if (typeof message.body !== "string") return { ok: false, code: "invalid_json" };

    // Cloudflare has returned both shapes in production. Try canonical base64
    // first, then the plain JSON representation. Both feed the same validator.
    const decoded = decodeBase64Utf8(message.body);
    if (decoded !== null) {
      const parsedDecoded = parseJson(decoded);
      if (parsedDecoded.ok) return parsedDecoded;
    }
    return parseJson(message.body);
  }

  if (contentType === "bytes") {
    if (typeof message.body !== "string") return { ok: false, code: "invalid_base64" };
    const decoded = decodeBase64Utf8(message.body);
    if (decoded === null) return { ok: false, code: "invalid_base64" };
    return parseJson(decoded);
  }

  if (contentType === undefined || contentType === "text") {
    return decodeUnencodedBody(message.body);
  }

  // The Workers-only v8 structured-clone format cannot be decoded by an HTTP
  // pull consumer. Unknown future formats also fail closed.
  return { ok: false, code: "unsupported_content_type" };
}

function validNonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function validIsoDate(value: unknown): value is string {
  return validNonEmptyString(value, 64) && Number.isFinite(Date.parse(value));
}

function validStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value)
    && Object.keys(value).length <= 1_000
    && Object.entries(value).every(
      ([key, entry]) => key.length <= 1_024 && typeof entry === "string" && entry.length <= 64 * 1_024,
    );
}

function copyStringRecord(value: Record<string, string>): Record<string, string> {
  // Object.fromEntries creates own data properties even for a key named
  // "__proto__". That avoids prototype mutation while retaining valid headers
  // or query keys byte-for-byte.
  return Object.fromEntries(Object.entries(value));
}

/** Validate the Cloudflare response envelope before lease ids are used. */
export function parsePulledBatchResponse(value: unknown): PulledMessage[] {
  if (!isRecord(value)) throw new PulledBatchContractError();
  if (value.success === false) throw new PulledBatchContractError();
  if (Array.isArray(value.errors) && value.errors.length > 0) {
    throw new PulledBatchContractError();
  }
  const result = value.result;
  if (result === undefined) return [];
  if (!isRecord(result)) throw new PulledBatchContractError();
  const messages = result.messages;
  if (messages === undefined) return [];
  if (!Array.isArray(messages)) throw new PulledBatchContractError();

  return messages.map((candidate) => {
    if (
      !isRecord(candidate)
      || !Object.hasOwn(candidate, "body")
      || !validNonEmptyString(candidate.id, 256)
      || !validNonEmptyString(candidate.lease_id, 8_192)
      || (candidate.attempts !== undefined
        && (!Number.isSafeInteger(candidate.attempts) || (candidate.attempts as number) < 0))
      || (candidate.timestamp_ms !== undefined
        && (!Number.isFinite(candidate.timestamp_ms) || (candidate.timestamp_ms as number) < 0))
    ) {
      throw new PulledBatchContractError();
    }

    // Cloudflare's HTTP Pull schema leaves metadata unconstrained and does not
    // give attempts a positive minimum. Only project the two string metadata
    // fields Axel understands; downstream validation still rejects any body
    // that is not an exact v0/v1 destination message.
    const metadata = isRecord(candidate.metadata)
      ? {
          ...(typeof candidate.metadata.CF_QUEUE_NAME === "string"
            ? { CF_QUEUE_NAME: candidate.metadata.CF_QUEUE_NAME }
            : {}),
          ...(typeof candidate.metadata["CF-Content-Type"] === "string"
            ? { "CF-Content-Type": candidate.metadata["CF-Content-Type"] }
            : {}),
        }
      : undefined;

    return {
      body: candidate.body,
      id: candidate.id,
      lease_id: candidate.lease_id,
      ...(candidate.attempts !== undefined ? { attempts: candidate.attempts as number } : {}),
      ...(candidate.timestamp_ms !== undefined ? { timestamp_ms: candidate.timestamp_ms as number } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
  });
}

/**
 * Validate and normalize a DestinationQueueMessage before it reaches delivery.
 *
 * Legacy version 0 is the exact pre-versioning shape with no
 * `queue_message_version`. It remains accepted for rolling deploys and queued
 * backlog, but the returned object always carries version 1. Any explicit
 * unknown version fails closed.
 */
export function validateDestinationQueueMessage(
  value: unknown,
): DestinationQueueMessageValidation {
  if (!isRecord(value)) return { ok: false, code: "body_not_object" };

  const rawVersion = value.queue_message_version;
  const wireVersion = rawVersion === undefined
    ? 0
    : rawVersion === DESTINATION_QUEUE_MESSAGE_VERSION
      ? DESTINATION_QUEUE_MESSAGE_VERSION
      : null;
  if (wireVersion === null) return { ok: false, code: "unsupported_version" };

  for (const field of REQUIRED_STRING_FIELDS) {
    if (!Object.hasOwn(value, field)) return { ok: false, code: "missing_field", field };
    const maxLength = field === "r2_key" ? 2_048 : 512;
    if (!validNonEmptyString(value[field], maxLength)) {
      return { ok: false, code: "invalid_field", field };
    }
  }

  for (const field of ["received_at", "enqueued_at"] as const) {
    if (!validIsoDate(value[field])) return { ok: false, code: "invalid_field", field };
  }

  for (const field of ["attempt_no", "max_attempts", "size_bytes", "payload", "headers", "query", "is_test"] as const) {
    if (!Object.hasOwn(value, field)) return { ok: false, code: "missing_field", field };
  }
  if (!Number.isSafeInteger(value.attempt_no) || (value.attempt_no as number) < 1) {
    return { ok: false, code: "invalid_field", field: "attempt_no" };
  }
  if (
    !Number.isSafeInteger(value.max_attempts)
    || (value.max_attempts as number) < 1
    || (value.max_attempts as number) > 1_000
  ) {
    return { ok: false, code: "invalid_field", field: "max_attempts" };
  }
  if ((value.attempt_no as number) > (value.max_attempts as number)) {
    return { ok: false, code: "invalid_field", field: "attempt_no" };
  }

  if (!Number.isSafeInteger(value.size_bytes) || (value.size_bytes as number) < 0) {
    return { ok: false, code: "invalid_field", field: "size_bytes" };
  }
  if (!validStringRecord(value.headers)) return { ok: false, code: "invalid_field", field: "headers" };
  if (!validStringRecord(value.query)) return { ok: false, code: "invalid_field", field: "query" };
  if (typeof value.is_test !== "boolean") return { ok: false, code: "invalid_field", field: "is_test" };

  if (value.next_attempt_at !== undefined && !validIsoDate(value.next_attempt_at)) {
    return { ok: false, code: "invalid_field", field: "next_attempt_at" };
  }
  if (value.binding !== undefined && value.binding !== null && !isRecord(value.binding)) {
    return { ok: false, code: "invalid_field", field: "binding" };
  }
  if (
    value.spill_r2_key !== undefined
    && value.spill_r2_key !== null
    && !validNonEmptyString(value.spill_r2_key, 2_048)
  ) {
    return { ok: false, code: "invalid_field", field: "spill_r2_key" };
  }
  if (
    value.ordering_token !== undefined
    && !validNonEmptyString(value.ordering_token, 1_024)
  ) {
    return { ok: false, code: "invalid_field", field: "ordering_token" };
  }

  const message: DestinationQueueMessage = {
    queue_message_version: DESTINATION_QUEUE_MESSAGE_VERSION,
    event_id: value.event_id as string,
    workspace_id: value.workspace_id as string,
    source_id: value.source_id as string,
    route_id: value.route_id as string,
    destination_id: value.destination_id as string,
    r2_key: value.r2_key as string,
    received_at: value.received_at as string,
    enqueued_at: value.enqueued_at as string,
    attempt_no: value.attempt_no as number,
    max_attempts: value.max_attempts as number,
    idempotency_key: value.idempotency_key as string,
    content_type: value.content_type as string,
    size_bytes: value.size_bytes as number,
    payload: value.payload,
    headers: copyStringRecord(value.headers),
    query: copyStringRecord(value.query),
    is_test: value.is_test,
    ...(value.next_attempt_at !== undefined ? { next_attempt_at: value.next_attempt_at as string } : {}),
    ...(value.binding !== undefined
      ? { binding: value.binding as RouteDestinationBinding | null }
      : {}),
    ...(value.spill_r2_key !== undefined
      ? { spill_r2_key: value.spill_r2_key as string | null }
      : {}),
    ...(value.ordering_token !== undefined
      ? { ordering_token: value.ordering_token as string }
      : {}),
  };

  return { ok: true, message, wireVersion };
}

/** Decode a Cloudflare HTTP Pull body, then validate its wire contract. */
export function parsePulledMessage(
  message: Pick<PulledMessage, "body" | "metadata">,
): DestinationQueueMessageValidation {
  const decoded = decodePulledMessageBody(message);
  if (!decoded.ok) return decoded;
  return validateDestinationQueueMessage(decoded.value);
}

/** Backward-compatible convenience wrapper for callers that only need a value. */
export function parsePulledMessageBody(
  message: Pick<PulledMessage, "body" | "metadata">,
): DestinationQueueMessage | null {
  const parsed = parsePulledMessage(message);
  return parsed.ok ? parsed.message : null;
}
