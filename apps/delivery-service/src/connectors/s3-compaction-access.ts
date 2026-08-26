/**
 * Real `CompactionS3Access` backed by an AWS S3 client. One instance is bound
 * to a single destination's credentials; the compaction loop builds one per
 * Parquet route. Kept separate from the orchestration so the latter stays
 * network-free and unit-testable.
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
// Same SSRF guard the delivery S3 connector uses (s3.ts). A DB-set custom
// endpoint must never point our compaction client at a metadata / internal
// host. AWS (no custom endpoint) is unaffected.
import { validateDestinationUrl } from "@axel/shared";
import { createSafeNodeHttpHandler } from "../safe-node-http-handler.js";
import { PARQUET_CONTENT_TYPE } from "./parquet-format.js";
import type { CompactionS3Access, CompactionS3Object } from "../parquet-compaction-loop.js";

export interface S3CompactionClientConfig {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  addressingStyle?: "path" | "virtual_hosted";
}

export function createS3CompactionAccess(config: S3CompactionClientConfig): CompactionS3Access {
  // Defensive SSRF guard: the loader (loadParquetCompactionRoutes) already
  // skips routes with an unsafe endpoint, but never build a network client for
  // a metadata/internal host even if a caller bypasses that path.
  if (config.endpoint) {
    const epSsrf = validateDestinationUrl(config.endpoint);
    if (epSsrf) {
      throw new Error(`ssrf_blocked: ${epSsrf}`);
    }
  }

  const client = new S3Client({
    region: config.region,
    requestHandler: createSafeNodeHttpHandler(),
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    ...(config.endpoint
      ? { endpoint: config.endpoint, forcePathStyle: config.addressingStyle !== "virtual_hosted" }
      : {}),
  });

  return {
    async list(bucket, prefix) {
      const out: CompactionS3Object[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const o of res.Contents ?? []) {
          if (!o.Key) continue;
          out.push({
            key: o.Key,
            sizeBytes: o.Size ?? 0,
            lastModifiedMs: o.LastModified ? o.LastModified.getTime() : 0,
          });
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return out;
    },

    async get(bucket, key) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const bytes = await res.Body!.transformToByteArray();
      return Buffer.from(bytes);
    },

    async put(bucket, key, body, metadata) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          // Manifest sidecars are JSON; everything else compaction writes is
          // Parquet.
          ContentType: key.endsWith(".json") ? "application/json" : PARQUET_CONTENT_TYPE,
          Metadata: metadata,
        }),
      );
    },

    async exists(bucket, key) {
      try {
        await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
        return true;
      } catch (err) {
        // Only a genuine 404/NotFound means the object is absent. Any other
        // error (transient 5xx after a successful PUT, a store without HEAD
        // support, throttling) must NOT be misread as "absent" — that would
        // let the caller's verified-PUT gate delete sources whose merged
        // replacement actually landed. Re-throw so the loop's per-job
        // try/catch records it as a real error (sources stay intact).
        if (isNotFound(err)) return false;
        throw err;
      }
    },

    async remove(bucket, keys) {
      if (keys.length === 0) return;
      // DeleteObjects caps at 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        const chunk = keys.slice(i, i + 1000);
        const res = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        // Quiet:true suppresses successful deletes from the response but still
        // reports per-key failures in Errors[]. Surfacing these is essential:
        // a silently-failed delete leaves the originals AND the merged copy,
        // double-counting rows on the next read. Throw so the caller records a
        // delete failure instead of assuming success.
        if (res.Errors && res.Errors.length > 0) {
          const detail = res.Errors.slice(0, 3)
            .map((e) => `${e.Key ?? "?"}: ${e.Code ?? ""} ${e.Message ?? ""}`.trim())
            .join("; ");
          throw new Error(
            `DeleteObjects reported ${res.Errors.length} failure(s): ${detail}`,
          );
        }
      }
    },
  };
}

/** True only for a genuine "object does not exist" HeadObject error. AWS SDK
 *  v3 surfaces this as `err.name === 'NotFound'` or an HTTP 404 in
 *  `$metadata.httpStatusCode`. Everything else (5xx, throttling, network) is a
 *  real error and must propagate. */
function isNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (e.name === "NotFound" || e.name === "NoSuchKey") return true;
  return e.$metadata?.httpStatusCode === 404;
}
