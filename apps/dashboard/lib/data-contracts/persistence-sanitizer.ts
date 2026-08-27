import "server-only";
import { redactSecretLikeText } from "@axel/shared";

/**
 * Data Contracts are durable schema metadata. Observed webhook values belong
 * in the short-lived preview response, never in a stored contract version.
 * Keep this scrub at the repository boundary so every writer gets the same
 * protection, including cron and pipeline-proposal paths.
 */

const VALUE_KEYS = new Set([
  "examples",
  "enum_values",
  "numeric_range",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scrubSchemaNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubSchemaNode);
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (VALUE_KEYS.has(key)) continue;
    if (key === "values" || key === "example_event_ids") {
      out[key] = [];
      continue;
    }
    out[key] = scrubSchemaNode(child);
  }
  return out;
}

function retainedSchemaSummary(schema: Record<string, unknown>): string {
  const fields = isRecord(schema.fields) ? Object.keys(schema.fields).length : 0;
  const eventTypes = Array.isArray(schema.event_types)
    ? schema.event_types.length
    : 0;
  const sampleCount = isRecord(schema.model_metadata)
    ? Number(schema.model_metadata.sample_count ?? 0)
    : 0;
  const safeSampleCount = Number.isFinite(sampleCount) && sampleCount >= 0
    ? Math.floor(sampleCount)
    : 0;
  return `Observed ${safeSampleCount} events across ${eventTypes} event types and ${fields} fields. Stored values removed.`;
}

export function sanitizeInferredSchemaForPersistence(value: unknown): unknown {
  if (!isRecord(value)) return {};
  const scrubbed = scrubSchemaNode(value) as Record<string, unknown>;
  scrubbed.summary = retainedSchemaSummary(scrubbed);
  return scrubbed;
}

function stripMappingPreviews(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMappingPreviews);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "preview") continue;
    out[key] = stripMappingPreviews(child);
  }
  return out;
}

export function sanitizeDestinationMappingForPersistence(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  return stripMappingPreviews(value);
}

/** Keep only aggregate fixture results. Failure payloads are transient UI data. */
export function sanitizeFixtureResultsForPersistence(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const key of ["passed", "failed", "total"]) {
    const count = Number(value[key]);
    if (Number.isFinite(count) && count >= 0) out[key] = Math.floor(count);
  }
  if (typeof value.ran_at === "string") out.ran_at = value.ran_at;
  return out;
}

const SAFE_MODEL_METADATA_KEYS = new Set([
  "model",
  "prompt_version",
  "sample_count",
  "llm_enriched",
  "ms",
  "auto",
  "auto_extended_at",
  "auto_extended_from_version_id",
  "manually_extended_at",
  "manually_extended_from_version_id",
  "manually_extended_by_user_id",
  "destination_mapping_saved_at",
  "destination_mapping_saved_by_user_id",
  "codegen_at",
  "codegen_by_user_id",
  "patched_at",
  "patched_by_user_id",
  "patch_confidence",
]);

/** Model prose and selected observed values are not durable provenance. */
export function sanitizeModelMetadataForPersistence(value: unknown): unknown {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => SAFE_MODEL_METADATA_KEYS.has(key)),
  );
}

const SAFE_STRUCTURAL_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

/**
 * Turn a fixture into a type-and-shape template. This deliberately replaces
 * every scalar, not merely values that look like PII. Secret detection can
 * never recognize arbitrary customer free text with complete accuracy.
 */
export function generalizeFixturePayload(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.length === 0 ? [] : [generalizeFixturePayload(value[0])];
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    let unsafeKeyIndex = 0;
    for (const [key, child] of Object.entries(value)) {
      const redactedKey = redactSecretLikeText(key);
      const safeKey = SAFE_STRUCTURAL_KEY.test(key) && redactedKey === key
        ? key
        : `field_${++unsafeKeyIndex}`;
      out[safeKey] = generalizeFixturePayload(child);
    }
    return out;
  }
  if (typeof value === "string") return "[STRING]";
  if (typeof value === "number") return 0;
  if (typeof value === "boolean") return false;
  return null;
}

export function sanitizeDriftDetailForPersistence(
  _category: string,
  _value: unknown,
): Record<string, unknown> {
  // The dashboard renders category and field_path only. Detail previously held
  // sampled event names and values without adding operator-visible behavior.
  return {};
}
