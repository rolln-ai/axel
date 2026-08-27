import { createHash } from "node:crypto";
import type pg from "pg";
import type {
  PulledMessage,
  PulledMessageFailureCode,
} from "./pulled-message.js";

export interface QueueQuarantineInput {
  queueName: string;
  message: PulledMessage;
  failure: {
    code: PulledMessageFailureCode;
    field?: string;
  };
}

function boundedText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maxLength)
    : null;
}

function bodyBytes(value: unknown): Buffer {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  try {
    const encoded = JSON.stringify(value);
    return Buffer.from(encoded ?? "undefined", "utf8");
  } catch {
    return Buffer.from("unserializable", "utf8");
  }
}

function contractVersion(value: unknown): number | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = (value as Record<string, unknown>).queue_message_version;
  return Number.isSafeInteger(candidate) ? (candidate as number) : null;
}

/**
 * Persist an invalid-envelope fingerprint before asking Cloudflare to retry it.
 *
 * This deliberately excludes the message body, payload, headers, query,
 * credentials, and lease ID. Cloudflare's retry/DLQ flow retains the original;
 * Postgres keeps only enough metadata to detect and investigate loss.
 */
export async function recordQueueQuarantine(
  pool: pg.Pool,
  input: QueueQuarantineInput,
): Promise<void> {
  const bytes = bodyBytes(input.message.body);
  const bodySha256 = createHash("sha256").update(bytes).digest("hex");
  const messageId = boundedText(input.message.id, 256) ?? `body:${bodySha256}`;
  const attempts = Number.isSafeInteger(input.message.attempts) && (input.message.attempts ?? 0) >= 1
    ? input.message.attempts!
    : 1;
  const publishedAt = Number.isFinite(input.message.timestamp_ms)
    ? new Date(input.message.timestamp_ms!).toISOString()
    : null;

  await pool.query(
    `WITH purged AS (
       DELETE FROM queue_quarantine
        WHERE expires_at <= now()
        RETURNING id
     )
     INSERT INTO queue_quarantine
       (queue_name, cloudflare_message_id, failure_code, failure_field,
        contract_version, attempts, content_type, published_at, body_sha256,
        body_size_bytes, first_seen_at, last_seen_at, seen_count, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), now(), 1,
             now() + interval '30 days')
     ON CONFLICT (queue_name, cloudflare_message_id) DO UPDATE
       SET failure_code = EXCLUDED.failure_code,
           failure_field = EXCLUDED.failure_field,
           contract_version = EXCLUDED.contract_version,
           attempts = GREATEST(queue_quarantine.attempts, EXCLUDED.attempts),
           content_type = EXCLUDED.content_type,
           published_at = COALESCE(queue_quarantine.published_at, EXCLUDED.published_at),
           body_sha256 = EXCLUDED.body_sha256,
           body_size_bytes = EXCLUDED.body_size_bytes,
           last_seen_at = now(),
           seen_count = queue_quarantine.seen_count + 1,
           expires_at = now() + interval '30 days'`,
    [
      boundedText(input.queueName, 128) ?? "delivery",
      messageId,
      input.failure.code,
      boundedText(input.failure.field, 128),
      contractVersion(input.message.body),
      attempts,
      boundedText(input.message.metadata?.["CF-Content-Type"], 128),
      publishedAt,
      bodySha256,
      bytes.byteLength,
    ],
  );
}
