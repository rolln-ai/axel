import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { Connector, DeliveryContext } from "@axel/connectors";
import { numericEnv as sharedNumericEnv, validateDestinationUrl, type Destination, type DeliveryAttempt, type ObjectStoreBinding } from "@axel/shared";
import {
  PARQUET_CONTENT_TYPE,
  writeParquetBuffer,
  type S3ParquetRow,
} from "./parquet-format.js";

/**
 * S3 destination connector. Writes each event as a JSON object under a
 * configurable key prefix.
 *
 * Config shape:
 *   {
 *     "bucket": "customer-archive",
 *     "region": "us-east-1",
 *     "access_key_id": "AKIA…",
 *     "secret_access_key": "…",
 *     "key_prefix": "axel/events/",          // optional, default ""
 *     "key_template": "{date}/{event_id}.json", // optional template
 *     "endpoint": "https://s3.example.com",  // optional, for S3-compatible
 *     "addressing_style": "path",            // optional: "path" or "virtual_hosted"
 *     "format": "json"                       // optional: "json" or "parquet"
 *   }
 *
 * Default key: `${prefix}${YYYY-MM-DD}/${event_id}.json`
 *
 * Token redaction: credentials live in `destinations.config.credentials_ref`
 * normally; for MVP we accept them inline. Real production should fetch from
 * a credentials vault.
 */

interface S3DestinationConfig {
  bucket: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  key_prefix?: string;
  key_template?: string;
  endpoint?: string;
  addressing_style?: "path" | "virtual_hosted";
  format?: "json" | "parquet";
  parquet_batch_max_rows?: number;
  parquet_flush_interval_ms?: number;
  parquet_target_bytes?: number;
}

const clients = new Map<string, S3Client>();
const textDecoder = new TextDecoder();
const DEFAULT_JSON_KEY_TEMPLATE = "{date}/{event_id}.json";
const DEFAULT_PARQUET_KEY_TEMPLATE = "{date}/part-{batch_id}.parquet";

// Parquet batching is tuned to avoid the small-files problem. A batch
// flushes when the FIRST of these is hit:
//   1. buffered (uncompressed) payload bytes >= target  — the primary
//      driver; yields ~target-sized objects at any throughput,
//   2. buffered rows >= max rows                         — a safety cap,
//   3. the batch has been open for >= flush interval     — a backstop so
//      low-volume routes still deliver within a bounded time.
// At low volume the byte/row triggers rarely fire, so the interval is the
// real knob: a longer interval packs more rows per file (fewer, larger
// files) at the cost of delivery latency. The 60s default cuts file count
// ~30x vs. the old 2s default; routes can override per binding. Targeting
// *uncompressed* bytes also bounds the in-memory buffer — SNAPPY makes the
// written object smaller than the target.
const DEFAULT_PARQUET_BATCH_MAX_ROWS = 50_000;
const DEFAULT_PARQUET_FLUSH_INTERVAL_MS = 60_000;
const DEFAULT_PARQUET_TARGET_BYTES = 64 * 1024 * 1024;
const MIN_PARQUET_BATCH_MAX_ROWS = 1;
const MAX_PARQUET_BATCH_MAX_ROWS = 500_000;
const MIN_PARQUET_FLUSH_INTERVAL_MS = 1_000;
const MAX_PARQUET_FLUSH_INTERVAL_MS = 900_000;
const MIN_PARQUET_TARGET_BYTES = 1 * 1024 * 1024;
const MAX_PARQUET_TARGET_BYTES = 512 * 1024 * 1024;
// Fixed per-row overhead (envelope columns) added to each payload's byte
// estimate so the byte target reflects more than just payload_json.
const PARQUET_ROW_OVERHEAD_BYTES = 256;

interface PendingParquetEntry {
  row: S3ParquetRow;
  eventId: string;
  startedAt: number;
  context: DeliveryContext | undefined;
  destination: Destination<S3DestinationConfig>;
  config: S3DestinationConfig;
  binding: ObjectStoreBinding;
  resolve: (attempt: DeliveryAttempt) => void;
}

interface ParquetBatchGroup {
  entries: PendingParquetEntry[];
  timer: NodeJS.Timeout | null;
  maxRows: number;
  targetBytes: number;
  /** Running sum of estimated uncompressed payload bytes in `entries`. */
  bufferedBytes: number;
}

const parquetBatchGroups = new Map<string, ParquetBatchGroup>();

function getClient(config: S3DestinationConfig): S3Client {
  // Include the secret in the cache key so a rotated/revoked secret yields a
  // FRESH client — keying on access_key_id alone reused a stale client (with the
  // old secret) after rotation until process restart, dead-lettering every event.
  const key = `${config.region}|${config.access_key_id}|${config.secret_access_key}|${config.endpoint ?? ""}|${config.addressing_style ?? ""}`;
  let client = clients.get(key);
  if (!client) {
    client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.access_key_id,
        secretAccessKey: config.secret_access_key,
      },
      ...(config.endpoint
        ? { endpoint: config.endpoint, forcePathStyle: config.addressing_style !== "virtual_hosted" }
        : {}),
    });
    clients.set(key, client);
  }
  return client;
}

function attemptOf(
  context: DeliveryContext | undefined,
  destination: Destination,
  status: DeliveryAttempt["status"],
  response: unknown,
  startedAt: number,
): DeliveryAttempt {
  return {
    attempt_id: `att_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    event_id: context?.eventId ?? "unknown",
    destination_id: destination.destination_id,
    status,
    response,
    latency_ms: Date.now() - startedAt,
    created_at: new Date().toISOString(),
  };
}

function buildKey(template: string | undefined, prefix: string, eventId: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const tmpl = template ?? DEFAULT_JSON_KEY_TEMPLATE;
  return prefix + tmpl.replaceAll("{date}", date).replaceAll("{event_id}", eventId);
}

function buildParquetKey(
  template: string | undefined,
  prefix: string,
  batchId: string,
  firstEventId: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const tmpl = template ?? DEFAULT_PARQUET_KEY_TEMPLATE;
  return prefix
    + tmpl
      .replaceAll("{date}", date)
      .replaceAll("{batch_id}", batchId)
      .replaceAll("{event_id}", firstEventId);
}

function resolveObjectStoreBinding(
  binding: unknown,
  config: S3DestinationConfig,
): ObjectStoreBinding {
  const out: ObjectStoreBinding = {};
  if (binding && typeof binding === "object" && !Array.isArray(binding)) {
    const b = binding as ObjectStoreBinding;
    const format = b.format === "json" || b.format === "parquet" ? b.format : undefined;
    const keyPrefix = b.key_prefix ?? config.key_prefix;
    const keyTemplate = b.key_template ?? (format === "parquet" ? undefined : config.key_template);
    if (keyPrefix !== undefined) out.key_prefix = keyPrefix;
    if (keyTemplate !== undefined) out.key_template = keyTemplate;
    if (format !== undefined) out.format = format;
    if (isPositiveInteger(b.parquet_batch_max_rows)) {
      out.parquet_batch_max_rows = b.parquet_batch_max_rows;
    }
    if (isPositiveInteger(b.parquet_flush_interval_ms)) {
      out.parquet_flush_interval_ms = b.parquet_flush_interval_ms;
    }
    if (isPositiveInteger(b.parquet_target_bytes)) {
      out.parquet_target_bytes = b.parquet_target_bytes;
    }
    return out;
  }
  if (config.key_prefix !== undefined) out.key_prefix = config.key_prefix;
  if (config.key_template !== undefined) out.key_template = config.key_template;
  if (config.format === "json" || config.format === "parquet") out.format = config.format;
  if (isPositiveInteger(config.parquet_batch_max_rows)) {
    out.parquet_batch_max_rows = config.parquet_batch_max_rows;
  }
  if (isPositiveInteger(config.parquet_flush_interval_ms)) {
    out.parquet_flush_interval_ms = config.parquet_flush_interval_ms;
  }
  if (isPositiveInteger(config.parquet_target_bytes)) {
    out.parquet_target_bytes = config.parquet_target_bytes;
  }
  return out;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function endpointGuardFailure(config: S3DestinationConfig): string | null {
  if (!config.endpoint) return null;
  const epSsrf = validateDestinationUrl(config.endpoint);
  return epSsrf ? `ssrf_blocked: ${epSsrf}` : null;
}

function classifyS3Failure(err: unknown): { status: DeliveryAttempt["status"]; message: string } {
  const message = err instanceof Error ? err.message : String(err);
  // AWS SDK v3 puts the error code on `.name` and the HTTP status on
  // `$metadata.httpStatusCode`; a message-only match misses token failures like
  // InvalidClientTokenId, whose message ("The security token … is invalid.")
  // contains none of the code strings (ROL-207).
  const name = err instanceof Error ? err.name : "";
  const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  // Permanent auth / config failures — dead-letter instead of retrying forever.
  const terminalCode =
    /(AccessDenied|NoSuchBucket|InvalidAccessKeyId|SignatureDoesNotMatch|InvalidClientTokenId|InvalidToken|TokenRefreshRequired|ExpiredToken|UnrecognizedClientException)/i;
  const terminal =
    terminalCode.test(name) ||
    terminalCode.test(message) ||
    httpStatus === 401 ||
    httpStatus === 403;
  return { status: terminal ? "dead" : "retry", message: message.slice(0, 500) };
}

export function createS3Connector(): Connector<S3DestinationConfig> {
  return {
    type: "s3",
    async deliver(event, destination, context) {
      const startedAt = Date.now();
      const config = destination.config;
      const eventId = context?.eventId ?? `evt_${Date.now().toString(36)}`;
      const binding = resolveObjectStoreBinding(context?.binding, config);

      // SSRF guard on a custom S3-compatible endpoint (operator-set, dialed
      // server-side): a DB-set endpoint must not PUT payloads to a metadata /
      // internal host. AWS (no custom endpoint) is unaffected.
      const endpointError = endpointGuardFailure(config);
      if (endpointError) {
        return attemptOf(context, destination, "dead", { error: endpointError }, startedAt);
      }

      if (binding.format === "parquet") {
        return enqueueParquetDelivery(event, destination, context, config, binding, startedAt, eventId);
      }

      const key = buildKey(binding.key_template, binding.key_prefix ?? "", eventId);
      try {
        const client = getClient(config);
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: new Uint8Array(event),
            ContentType: "application/json",
            // Hyphenated keys to match delivery-edge's x-amz-meta-event-id /
            // x-amz-meta-workspace-id — same destination must yield the same
            // metadata schema regardless of which runtime delivered.
            Metadata: {
              "event-id": eventId,
              "workspace-id": destination.workspace_id,
            },
          }),
        );
        return attemptOf(
          context,
          destination,
          "success",
          { bucket: config.bucket, key },
          startedAt,
        );
      } catch (err) {
        const failure = classifyS3Failure(err);
        return attemptOf(
          context,
          destination,
          failure.status,
          { error: failure.message, key },
          startedAt,
        );
      }
    },
  };
}

function enqueueParquetDelivery(
  event: ArrayBuffer,
  destination: Destination<S3DestinationConfig>,
  context: DeliveryContext | undefined,
  config: S3DestinationConfig,
  binding: ObjectStoreBinding,
  startedAt: number,
  eventId: string,
): Promise<DeliveryAttempt> {
  const groupKey = parquetGroupKey(destination, context, config, binding);
  const maxRows = resolvedParquetBatchMaxRows(binding, config);
  const flushIntervalMs = resolvedParquetFlushIntervalMs(binding, config);
  const targetBytes = resolvedParquetTargetBytes(binding, config);
  let group = parquetBatchGroups.get(groupKey);
  if (!group) {
    group = {
      entries: [],
      maxRows,
      targetBytes,
      bufferedBytes: 0,
      timer: null,
    };
    parquetBatchGroups.set(groupKey, group);
    group.timer = setTimeout(() => {
      void flushParquetGroup(groupKey);
    }, flushIntervalMs);
    group.timer.unref?.();
  }

  const estimatedBytes = event.byteLength + PARQUET_ROW_OVERHEAD_BYTES;
  return new Promise<DeliveryAttempt>((resolve) => {
    group.entries.push({
      row: parquetRowFromEvent(event, destination, context, eventId),
      eventId,
      startedAt,
      context,
      destination,
      config,
      binding,
      resolve,
    });
    group.bufferedBytes += estimatedBytes;
    // Flush as soon as we hit the size target or the row safety cap; the
    // timer handles the low-volume case where neither is reached.
    if (group.entries.length >= group.maxRows || group.bufferedBytes >= group.targetBytes) {
      void flushParquetGroup(groupKey);
    }
  });
}

function parquetGroupKey(
  destination: Destination<S3DestinationConfig>,
  context: DeliveryContext | undefined,
  config: S3DestinationConfig,
  binding: ObjectStoreBinding,
): string {
  return JSON.stringify([
    destination.workspace_id,
    destination.destination_id,
    context?.routeId ?? "",
    config.bucket,
    config.region,
    config.access_key_id,
    config.secret_access_key,
    config.endpoint ?? "",
    config.addressing_style ?? "",
    binding.key_prefix ?? "",
    binding.key_template ?? "",
  ]);
}

function parquetRowFromEvent(
  event: ArrayBuffer,
  destination: Destination<S3DestinationConfig>,
  context: DeliveryContext | undefined,
  eventId: string,
): S3ParquetRow {
  return {
    event_id: eventId,
    workspace_id: context?.workspaceId ?? destination.workspace_id,
    source_id: context?.sourceId ?? "",
    route_id: context?.routeId ?? "",
    destination_id: destination.destination_id,
    received_at: validIsoOrNow(context?.receivedAt),
    written_at: new Date().toISOString(),
    payload_json: textDecoder.decode(event),
  };
}

function validIsoOrNow(value: string | undefined): string {
  if (!value) return new Date().toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

async function flushParquetGroup(groupKey: string): Promise<void> {
  const group = parquetBatchGroups.get(groupKey);
  if (!group || group.entries.length === 0) return;
  parquetBatchGroups.delete(groupKey);
  if (group.timer) clearTimeout(group.timer);

  const entries = group.entries.splice(0);
  const first = entries[0];
  if (!first) return;
  const batchId = `batch_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const key = buildParquetKey(
    first.binding.key_template,
    first.binding.key_prefix ?? "",
    batchId,
    first.eventId,
  );

  try {
    const body = await writeParquetBuffer(entries.map((entry) => entry.row), {
      batchId,
      destinationId: first.destination.destination_id,
      routeId: first.context?.routeId ?? "",
      workspaceId: first.context?.workspaceId ?? first.destination.workspace_id,
    });
    const client = getClient(first.config);
    await client.send(
      new PutObjectCommand({
        Bucket: first.config.bucket,
        Key: key,
        Body: body,
        ContentType: PARQUET_CONTENT_TYPE,
        Metadata: {
          batch_id: batchId,
          format: "parquet",
          row_count: String(entries.length),
          workspace_id: first.context?.workspaceId ?? first.destination.workspace_id,
          route_id: first.context?.routeId ?? "",
        },
      }),
    );
    for (const entry of entries) {
      entry.resolve(
        attemptOf(
          entry.context,
          entry.destination,
          "success",
          { bucket: first.config.bucket, key, format: "parquet", batch_id: batchId, rows: entries.length },
          entry.startedAt,
        ),
      );
    }
  } catch (err) {
    const failure = classifyS3Failure(err);
    for (const entry of entries) {
      entry.resolve(
        attemptOf(
          entry.context,
          entry.destination,
          failure.status,
          { error: failure.message, key, format: "parquet" },
          entry.startedAt,
        ),
      );
    }
  }
}

function resolvedParquetBatchMaxRows(
  binding: ObjectStoreBinding,
  config: S3DestinationConfig,
): number {
  const configured = binding.parquet_batch_max_rows ?? config.parquet_batch_max_rows;
  return clampPositiveInteger(
    configured ?? numericEnv("S3_PARQUET_BATCH_MAX_ROWS", DEFAULT_PARQUET_BATCH_MAX_ROWS),
    MIN_PARQUET_BATCH_MAX_ROWS,
    MAX_PARQUET_BATCH_MAX_ROWS,
  );
}

function resolvedParquetFlushIntervalMs(
  binding: ObjectStoreBinding,
  config: S3DestinationConfig,
): number {
  const configured = binding.parquet_flush_interval_ms ?? config.parquet_flush_interval_ms;
  return clampPositiveInteger(
    configured ?? numericEnv("S3_PARQUET_FLUSH_MS", DEFAULT_PARQUET_FLUSH_INTERVAL_MS),
    MIN_PARQUET_FLUSH_INTERVAL_MS,
    MAX_PARQUET_FLUSH_INTERVAL_MS,
  );
}

function resolvedParquetTargetBytes(
  binding: ObjectStoreBinding,
  config: S3DestinationConfig,
): number {
  const configured = binding.parquet_target_bytes ?? config.parquet_target_bytes;
  return clampPositiveInteger(
    configured ?? numericEnv("S3_PARQUET_TARGET_BYTES", DEFAULT_PARQUET_TARGET_BYTES),
    MIN_PARQUET_TARGET_BYTES,
    MAX_PARQUET_TARGET_BYTES,
  );
}

function numericEnv(name: string, fallback: number): number {
  return sharedNumericEnv(process.env, name, fallback);
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export async function flushAllS3ParquetBatches(): Promise<void> {
  await Promise.all([...parquetBatchGroups.keys()].map((groupKey) => flushParquetGroup(groupKey)));
}

export function closeAllS3Clients(): void {
  for (const c of clients.values()) c.destroy();
  clients.clear();
}
