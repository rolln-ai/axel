import type { DestinationQueueMessage } from "@axel/shared";

export interface PulledMessage {
  body: unknown;
  lease_id: string;
  id: string;
  metadata?: {
    CF_QUEUE_NAME?: string;
    "CF-Content-Type"?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonObject(value: string): DestinationQueueMessage | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? (parsed as unknown as DestinationQueueMessage) : null;
  } catch {
    return null;
  }
}

function decodeBase64Utf8(value: string): string | null {
  // Cloudflare documents RFC 4648 base64. Check the alphabet and canonical
  // round-trip because Buffer.from(..., "base64") otherwise accepts malformed
  // input by silently discarding invalid characters.
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

function parseUnencodedBody(raw: unknown): DestinationQueueMessage | null {
  if (typeof raw === "string") return parseJsonObject(raw);
  if (!isRecord(raw)) return null;

  // Retain compatibility with earlier test fixtures that wrapped a body once.
  if ("body" in raw && Object.keys(raw).length === 1) {
    return parseUnencodedBody(raw.body);
  }
  return raw as unknown as DestinationQueueMessage;
}

/**
 * Decode a Cloudflare Queues HTTP Pull message.
 *
 * Pull consumers receive both `json` and `bytes` bodies as base64, while
 * `text` bodies are plain UTF-8. Axel publishes JSON, but accepting bytes here
 * makes the failure mode safe if a queue producer is reconfigured.
 */
export function parsePulledMessageBody(
  message: Pick<PulledMessage, "body" | "metadata">,
): DestinationQueueMessage | null {
  const contentType = message.metadata?.["CF-Content-Type"];

  if (contentType === "json" || contentType === "bytes") {
    if (typeof message.body !== "string") return null;
    const decoded = decodeBase64Utf8(message.body);
    return decoded === null ? null : parseJsonObject(decoded);
  }

  if (contentType === undefined || contentType === "text") {
    return parseUnencodedBody(message.body);
  }

  // In particular, the Workers-only `v8` format cannot be decoded by an HTTP
  // pull consumer. Fail closed so it is never mistaken for an Axel message.
  return null;
}
