import type {
  ClusterSchema,
  EventTypeCluster,
  FieldSpec,
  InferredDataContract,
} from "./inference";

/**
 * Synthesize a valid test payload from a Data Contract cluster's schema.
 *
 * Goal: when the operator clicks "Generate from Data Contract → invoice.paid",
 * we hand back a JSON object that conforms to the inferred shape — same
 * keys, same types, real-looking values per field category. Then they
 * can edit before sending, and the result feeds the same ingest path
 * as the canned presets.
 *
 * Value selection priority for each field:
 *   1. spec.examples[0] when present (real observed values are best).
 *   2. spec.enum_values[0] for low-cardinality strings.
 *   3. spec.numeric_range midpoint for numerics.
 *   4. Category-aware default ("user@example.com" for email, "https://…"
 *      for url, ISO timestamp for timestamp, etc).
 *   5. Type-shape default (empty string / 0 / false / {} / []).
 *
 * Optional fields are included with their best-guess values too — most
 * downstream consumers tolerate extra keys, and a payload missing all
 * optional fields tends to confuse "is this really what we emit?"
 * dogfooding loops.
 */
export function synthesizePayload(
  schema: InferredDataContract,
  clusterId?: string,
): { payload: unknown; cluster: EventTypeCluster | null } {
  if (schema.event_types.length === 0) {
    return { payload: {}, cluster: null };
  }
  const cluster =
    (clusterId
      ? schema.event_types.find((c) => c.cluster_id === clusterId)
      : null) ?? schema.event_types[0]!;
  const slice: ClusterSchema =
    schema.per_cluster?.[cluster.cluster_id] ?? {
      fields: schema.fields,
      ids: schema.ids,
      timestamps: schema.timestamps,
      status_fields: schema.status_fields,
      sensitive_fields: schema.sensitive_fields,
    };
  return { payload: buildFromFields(slice.fields, cluster.name), cluster };
}

function buildFromFields(
  fields: Record<string, FieldSpec>,
  clusterName: string,
): unknown {
  const root: Record<string, unknown> = {};
  const entries = Object.entries(fields).filter(([p]) => p !== "$");
  for (const [path, spec] of entries) {
    setPath(root, path, valueFor(spec, path, clusterName));
  }
  return root;
}

function valueFor(spec: FieldSpec, _path: string, clusterName: string): unknown {
  // First non-null observed example wins — preserves real shape.
  if (spec.examples && spec.examples.length > 0) {
    const ex = spec.examples.find((e) => e !== null);
    if (ex !== undefined) return ex;
  }
  if (spec.enum_values && spec.enum_values.length > 0) {
    return spec.enum_values[0]!;
  }
  if (spec.numeric_range) {
    return Math.round((spec.numeric_range.min + spec.numeric_range.max) / 2);
  }
  if (spec.types.length === 1 && spec.types[0] === "null") return null;

  const category = spec.category ?? "string";
  switch (category) {
    case "email":
      return "test@example.com";
    case "url":
      return "https://example.com/test";
    case "uuid":
      return "00000000-0000-4000-8000-000000000000";
    case "phone":
      return "+14155550100";
    case "currency_code":
      return "USD";
    case "country_code":
      return "US";
    case "boolean":
      return false;
    case "numeric":
      return 0;
    case "timestamp": {
      // Heuristic on shape — unix ms vs unix s vs iso8601 by the example type.
      if (spec.types.includes("number")) return Math.floor(Date.now() / 1000);
      return new Date().toISOString();
    }
    case "id":
      // Use a stable-ish synthesized ID. Suffix on cluster name so test
      // payloads for different event types don't collide on idempotency.
      return `test_${clusterName.replace(/[^A-Za-z0-9]+/g, "_")}_${Date.now()}`;
    case "enum":
      // Already covered by enum_values branch above; reach here only
      // when enum is empty — fall through to type default.
      return "";
    case "object":
      return {};
    case "array":
      return [];
    case "null":
      return null;
    case "mixed":
    case "string":
    default: {
      if (spec.types.includes("string")) return "";
      if (spec.types.includes("number")) return 0;
      if (spec.types.includes("boolean")) return false;
      if (spec.types.includes("array")) return [];
      if (spec.types.includes("object")) return {};
      return null;
    }
  }
}

function setPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const raw = parts[i]!;
    const isArr = raw.endsWith("[]");
    const key = isArr ? raw.slice(0, -2) : raw;
    if (key === "__proto__" || key === "constructor" || key === "prototype") return;
    if (isArr) {
      // Array children — create / reuse the array, then operate on [0].
      let arr = cur[key];
      if (!Array.isArray(arr)) {
        arr = [];
        cur[key] = arr;
      }
      const a = arr as unknown[];
      if (typeof a[0] !== "object" || a[0] === null) a[0] = {};
      cur = a[0] as Record<string, unknown>;
    } else {
      if (
        typeof cur[key] !== "object" ||
        cur[key] === null ||
        Array.isArray(cur[key])
      ) {
        cur[key] = {};
      }
      cur = cur[key] as Record<string, unknown>;
    }
  }
  const lastRaw = parts[parts.length - 1]!;
  const isArr = lastRaw.endsWith("[]");
  const lastKey = isArr ? lastRaw.slice(0, -2) : lastRaw;
  if (lastKey === "__proto__" || lastKey === "constructor" || lastKey === "prototype") return;
  if (isArr) {
    cur[lastKey] = [value];
  } else {
    cur[lastKey] = value;
  }
}
