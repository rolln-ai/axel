import {
  summarizeWebhookFieldPathForAi,
  type GeneratedFilter,
  type GeneratedTransform,
} from "@axel/shared";

const DESTINATION_TYPES = new Set([
  "bigquery",
  "databricks_sql",
  "databricks_volume",
  "http",
  "mongodb",
  "postgres",
  "r2",
  "s3",
  "webhook",
]);

const FAILURE_REASONS = new Set([
  "breaker_half_open_test_failed",
  "breaker_open_cooldown_active",
  "connector_failed",
  "declarative_engine_error",
  "delivery_dead",
  "delivery_overloaded",
  "delivery_paused",
  "delivery_service_503",
  "destination_disabled_manually",
  "destination_rejected",
  "half_open_probe_in_flight",
  "half_open_probe_timed_out",
  "payload_missing",
  "raw_payload_missing",
  "retry_after_window_active",
  "router_processing_failed",
  "spill_r2_key_missing",
]);
const MAX_SERIALIZED_DSL_LENGTH = 64_000;

export function safeDestinationTypeForAi(value: string): string {
  return DESTINATION_TYPES.has(value) ? value : "[unavailable]";
}

export function safeFailureReasonForAi(value: string): string {
  if (FAILURE_REASONS.has(value)) return value;
  if (value.startsWith("filter_")) return "filter_error";
  if (value.startsWith("transform_")) return "transform_error";
  return "[unavailable]";
}

export function safeHttpStatusForAi(value: number): number | "[unavailable]" {
  return Number.isInteger(value) && (value === 0 || (value >= 100 && value <= 599))
    ? value
    : "[unavailable]";
}

export function summarizeTransformForAi(
  transform: GeneratedTransform | unknown,
): Record<string, unknown> {
  if (!transform || typeof transform !== "object" || Array.isArray(transform)) {
    return { kind: "[unavailable]" };
  }
  const value = transform as Record<string, unknown>;
  switch (value.kind) {
    case "passthrough":
      return { kind: "passthrough" };
    case "select": {
      if (!value.assignments || typeof value.assignments !== "object" || Array.isArray(value.assignments)) {
        return { kind: "select", assignments: "[unavailable]" };
      }
      const assignments = Object.entries(value.assignments as Record<string, unknown>)
        .slice(0, 40)
        .flatMap(([outputPath, inputPath]) =>
          typeof inputPath === "string"
            ? [
                {
                  output_path: summarizeWebhookFieldPathForAi(outputPath),
                  input_path: summarizeWebhookFieldPathForAi(inputPath),
                },
              ]
            : [],
        );
      return { kind: "select", assignments };
    }
    case "coerce":
      return {
        kind: "coerce",
        fields: summarizeTransformFields(value.fields, (field) => {
          const to = ["boolean", "integer", "number", "string"].includes(String(field.to))
            ? field.to
            : "[unavailable]";
          const rounding = ["ceil", "floor", "round", "truncate"].includes(
            String(field.rounding),
          )
            ? field.rounding
            : undefined;
          return {
            path: safePathValue(field.path),
            to,
            ...(rounding ? { rounding } : {}),
          };
        }),
      };
    case "collapse_arrays":
      return {
        kind: "collapse_arrays",
        fields: summarizeTransformFields(value.fields, (field) => ({
          path: safePathValue(field.path),
          format: field.format === "join" || field.format === "json"
            ? field.format
            : "[unavailable]",
          separator_present: typeof field.separator === "string",
        })),
      };
    case "envelope":
      return {
        kind: "envelope",
        event_type_path: nullablePathValue(value.event_type_path),
        occurred_at_path: nullablePathValue(value.occurred_at_path),
      };
    case "jsonb_blob":
      return {
        kind: "jsonb_blob",
        column: safePathValue(value.column),
      };
    default:
      return { kind: "[unavailable]" };
  }
}

export function summarizeFilterForAi(
  filter: GeneratedFilter | unknown,
  depth = 0,
): Record<string, unknown> {
  if (depth > 6 || !filter || typeof filter !== "object" || Array.isArray(filter)) {
    return { kind: "[unavailable]" };
  }
  const value = filter as Record<string, unknown>;
  switch (value.kind) {
    case "always":
      return { kind: "always" };
    case "event_type_in":
      return {
        kind: "event_type_in",
        path: safePathValue(value.path),
        values_withheld: true,
      };
    case "and":
    case "or":
      return {
        kind: value.kind,
        parts: Array.isArray(value.parts)
          ? value.parts.slice(0, 20).map((part) => summarizeFilterForAi(part, depth + 1))
          : [],
      };
    default:
      return { kind: "[unavailable]" };
  }
}

export function summarizeSerializedTransformForAi(serialized: string | null): unknown {
  if (!serialized) return null;
  if (serialized.length > MAX_SERIALIZED_DSL_LENGTH) return { kind: "[unavailable]" };
  try {
    return summarizeTransformForAi(JSON.parse(serialized));
  } catch {
    return { kind: "[unavailable]" };
  }
}

export function summarizeSerializedFilterForAi(serialized: string | null): unknown {
  if (!serialized) return null;
  if (serialized.length > MAX_SERIALIZED_DSL_LENGTH) return { kind: "[unavailable]" };
  try {
    return summarizeFilterForAi(JSON.parse(serialized));
  } catch {
    return { kind: "[unavailable]" };
  }
}

function summarizeTransformFields(
  value: unknown,
  summarize: (field: Record<string, unknown>) => Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 40)
    .flatMap((field) =>
      field && typeof field === "object" && !Array.isArray(field)
        ? [summarize(field as Record<string, unknown>)]
        : [],
    );
}

function safePathValue(value: unknown): string {
  return typeof value === "string"
    ? summarizeWebhookFieldPathForAi(value)
    : "[unavailable]";
}

function nullablePathValue(value: unknown): string | null {
  return value === null ? null : safePathValue(value);
}
