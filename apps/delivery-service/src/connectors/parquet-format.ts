/**
 * Shared Parquet schema + read/write/merge helpers.
 *
 * Both the S3 delivery connector (which writes one object per flushed batch)
 * and the compaction worker (which merges small objects into large ones) must
 * agree byte-for-byte on the schema, so it lives here rather than inside the
 * connector. Keeping the reader/writer/merge in one place also means the
 * round-trip is tested in a single spot.
 */
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { finished } from "node:stream/promises";

const require = createRequire(import.meta.url);
const parquet = require("parquetjs-lite") as typeof import("parquetjs-lite");

export const PARQUET_CONTENT_TYPE = "application/vnd.apache.parquet";
/** Bounds the writer's per-row-group memory during serialization. */
export const PARQUET_ROW_GROUP_SIZE = 10_000;

export const PARQUET_SCHEMA = new parquet.ParquetSchema({
  event_id: { type: "UTF8", compression: "SNAPPY" },
  workspace_id: { type: "UTF8", compression: "SNAPPY" },
  source_id: { type: "UTF8", compression: "SNAPPY" },
  route_id: { type: "UTF8", compression: "SNAPPY" },
  destination_id: { type: "UTF8", compression: "SNAPPY" },
  // ISO-8601 strings rather than TIMESTAMP_MILLIS: parquetjs-lite's reader
  // throws on reading INT64-backed timestamps (`+bigint`), which would break
  // compaction's read-merge cycle. Strings round-trip cleanly and are still
  // castable to timestamp in Athena/DuckDB/Spark.
  received_at: { type: "UTF8", compression: "SNAPPY" },
  written_at: { type: "UTF8", compression: "SNAPPY" },
  payload_json: { type: "UTF8", compression: "SNAPPY" },
});

export interface S3ParquetRow extends Record<string, string> {
  event_id: string;
  workspace_id: string;
  source_id: string;
  route_id: string;
  destination_id: string;
  /** ISO-8601. */
  received_at: string;
  /** ISO-8601. */
  written_at: string;
  payload_json: string;
}

export interface ParquetFileMetadata {
  batchId: string;
  workspaceId: string;
  routeId: string;
  destinationId: string;
}

/** Serialize rows into a single Parquet file buffer. */
export async function writeParquetBuffer(
  rows: S3ParquetRow[],
  metadata: ParquetFileMetadata,
): Promise<Buffer> {
  const sink = new BufferSink();
  const writer = await parquet.ParquetWriter.openStream(PARQUET_SCHEMA, sink, {
    rowGroupSize: Math.min(rows.length || 1, PARQUET_ROW_GROUP_SIZE),
  });
  writer.setMetadata("axel_batch_id", metadata.batchId);
  writer.setMetadata("axel_workspace_id", metadata.workspaceId);
  writer.setMetadata("axel_route_id", metadata.routeId);
  writer.setMetadata("axel_destination_id", metadata.destinationId);
  for (const row of rows) {
    await writer.appendRow(row);
  }
  await writer.close();
  await finished(sink);
  return sink.toBuffer();
}

/** Read every row back out of a Parquet file buffer, coercing the timestamp
 *  columns back to `Date` so the rows can be re-written unchanged. */
export async function readParquetRows(buffer: Buffer): Promise<S3ParquetRow[]> {
  const reader = await parquet.ParquetReader.openBuffer(buffer);
  try {
    const cursor = reader.getCursor();
    const rows: S3ParquetRow[] = [];
    while (true) {
      const raw: Record<string, unknown> | null = await cursor.next();
      if (raw === null) break;
      rows.push({
        event_id: String(raw.event_id ?? ""),
        workspace_id: String(raw.workspace_id ?? ""),
        source_id: String(raw.source_id ?? ""),
        route_id: String(raw.route_id ?? ""),
        destination_id: String(raw.destination_id ?? ""),
        received_at: toIsoTimestamp(raw.received_at),
        written_at: toIsoTimestamp(raw.written_at),
        payload_json: String(raw.payload_json ?? ""),
      });
    }
    return rows;
  } finally {
    await reader.close();
  }
}

/**
 * Coerce a timestamp column back to an ISO-8601 string. New files store these
 * as UTF8 ISO strings (round-trips as-is), but files written before the
 * string-schema migration used TIMESTAMP_MILLIS — a JS Date / epoch number,
 * where `String(date)` yields a non-ISO locale string that downstream parsers
 * (Athena/DuckDB/Spark) reject. Normalize Dates/numbers explicitly.
 */
function toIsoTimestamp(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  return String(value ?? "");
}

/** Merge several Parquet file buffers into one, preserving every row. */
export async function mergeParquetBuffers(
  buffers: Buffer[],
  metadata: ParquetFileMetadata,
): Promise<{ buffer: Buffer; rowCount: number }> {
  const rows: S3ParquetRow[] = [];
  // Decode one input at a time and release each buffer immediately after, so
  // peak memory is the accumulating rows + a single input buffer rather than
  // every compressed input held at once (the worker shares a 512MB plan).
  const inputs = buffers as (Buffer | undefined)[];
  for (let i = 0; i < inputs.length; i++) {
    const buf = inputs[i];
    if (!buf) continue;
    rows.push(...(await readParquetRows(buf)));
    inputs[i] = undefined; // free the decoded input for GC
  }
  const buffer = await writeParquetBuffer(rows, metadata);
  return { buffer, rowCount: rows.length };
}

class BufferSink extends Writable {
  private readonly chunks: Buffer[] = [];

  override _write(
    chunk: Buffer | string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (typeof chunk === "string") {
      this.chunks.push(Buffer.from(chunk, encoding));
    } else {
      this.chunks.push(Buffer.from(chunk));
    }
    callback();
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}
