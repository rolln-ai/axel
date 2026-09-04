import type {
  DestinationQueueMessage,
  RouteDestinationBinding,
} from "./types.js";
import { isCanonicalRawPayloadKey } from "./raw-payload-key.js";

export const DESTINATION_QUEUE_MESSAGE_VERSION = 1 as const;

export type DestinationQueueMessageFailureCode =
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
      code: DestinationQueueMessageFailureCode;
      /** Field name only. Never includes a field value or payload excerpt. */
      field?: string;
    };

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

/**
 * Validate an untrusted destination-queue body before any storage, database,
 * or connector access. The implementation uses only Web Platform APIs so both
 * Cloudflare Workers and Node consumers can share the same wire contract.
 *
 * Legacy version 0 is the exact pre-versioning shape with no
 * `queue_message_version`. It remains accepted for a rolling deploy and queued
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
  if (!isCanonicalRawPayloadKey(value.r2_key as string, {
    workspaceId: value.workspace_id as string,
    sourceId: value.source_id as string,
  })) {
    return { ok: false, code: "invalid_field", field: "r2_key" };
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
    // Rolling/backlogged pre-hardening messages may carry inbound request
    // values. Validate the legacy shape above, then erase it before delivery.
    headers: {},
    query: {},
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
