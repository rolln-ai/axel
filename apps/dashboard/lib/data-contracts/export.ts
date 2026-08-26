import type {
  ClusterSchema,
  EventTypeCluster,
  FieldSpec,
  InferredDataContract,
  SensitiveField,
} from "./inference";

/**
 * Schema export. Takes an InferredDataContract and produces operator-facing
 * artifacts that customers can put in their downstream codebase:
 *
 *   - Markdown — human docs for an internal wiki or README.
 *   - TypeScript — per-cluster interfaces + a discriminated union the
 *     customer's code can `import type` and pattern-match on.
 *   - JSON Schema — for API tooling, contract testing, OpenAPI build
 *     steps. JSON Schema 2020-12.
 *
 * All three exports work whether the map has multiple event types or
 * just one. Sensitive fields are flagged in the output (// SENSITIVE
 * comment in TS, ▲ marker in Markdown, `x-sensitive: true` in JSON
 * Schema) so the artifact carries the operator's safety classification.
 */

export interface ExportContext {
  /** Display name for the Data Contract (used in headings + interface prefixes). */
  name: string;
}

const TYPE_MAP_TS: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  null: "null",
  object: "Record<string, unknown>",
  array: "unknown[]",
};

const TYPE_MAP_JSON: Record<string, string> = {
  string: "string",
  number: "number",
  boolean: "boolean",
  null: "null",
  object: "object",
  array: "array",
};

function tsIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (cleaned.length === 0) return "Event";
  return cleaned
    .split(/\s+/)
    .map((p) => (p[0]?.toUpperCase() ?? "") + p.slice(1))
    .join("")
    .replace(/^[0-9]/, (d) => `_${d}`);
}

function sensitivePaths(schema: ClusterSchema | InferredDataContract): Set<string> {
  const fields = (schema.sensitive_fields ?? []) as SensitiveField[];
  return new Set(fields.map((s) => s.path));
}

function clusterSlice(schema: InferredDataContract, cluster: EventTypeCluster): ClusterSchema {
  const per = schema.per_cluster?.[cluster.cluster_id];
  if (per) return per;
  return {
    fields: schema.fields,
    ids: schema.ids,
    timestamps: schema.timestamps,
    status_fields: schema.status_fields,
    sensitive_fields: schema.sensitive_fields,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

export function toMarkdown(
  schema: InferredDataContract,
  context: ExportContext,
): string {
  const lines: string[] = [];
  lines.push(`# ${context.name}`);
  lines.push("");
  lines.push(schema.summary || "_(no summary)_");
  lines.push("");
  if (schema.event_types.length === 0) {
    lines.push("_No event types detected yet._");
    return lines.join("\n");
  }
  for (const cluster of schema.event_types) {
    const slice = clusterSlice(schema, cluster);
    lines.push(`## ${cluster.name}`);
    lines.push("");
    lines.push(`Samples: ${cluster.sample_count}.`);
    lines.push("");
    lines.push("| Field | Type | Required | Category | Notes |");
    lines.push("| --- | --- | --- | --- | --- |");
    const sensitiveSet = sensitivePaths(slice);
    const entries = Object.entries(slice.fields)
      .filter(([p]) => p !== "$")
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [path, spec] of entries) {
      const types = (spec.types ?? []).join(" \\| ");
      const required = spec.required ? "yes" : `${Math.round(spec.presence * 100)}%`;
      const category = spec.category ?? "string";
      const notes: string[] = [];
      if (sensitiveSet.has(path)) notes.push("▲ sensitive");
      if (spec.enum_values && spec.enum_values.length > 0) {
        notes.push(`values: ${spec.enum_values.map((v) => `\`${v}\``).join(", ")}`);
      } else if (spec.numeric_range) {
        notes.push(`range ${spec.numeric_range.min} – ${spec.numeric_range.max}`);
      } else if (spec.examples && spec.examples.length > 0) {
        notes.push(`e.g. ${spec.examples.slice(0, 2).map(formatExample).join(", ")}`);
      }
      lines.push(
        `| \`${path}\` | ${types || "—"} | ${required} | ${category} | ${notes.join("; ") || "—"} |`,
      );
    }
    if (slice.ids.length > 0) {
      lines.push("");
      lines.push(
        `**IDs:** ${slice.ids.map((i) => `\`${i.path}\` (${Math.round(i.uniqueness * 100)}% unique)`).join(", ")}`,
      );
    }
    if (slice.timestamps.length > 0) {
      lines.push("");
      lines.push(
        `**Timestamps:** ${slice.timestamps.map((t) => `\`${t.path}\` (${t.format})`).join(", ")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatExample(v: string | number | boolean | null): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

// ---------------------------------------------------------------------------
// TypeScript
// ---------------------------------------------------------------------------

export function toTypeScript(
  schema: InferredDataContract,
  context: ExportContext,
): string {
  const lines: string[] = [];
  const base = tsIdentifier(context.name);
  lines.push(`// Generated by Axel from Data Contract "${context.name}".`);
  lines.push(`// ▲ Sensitive paths are commented inline — never log or persist`);
  lines.push(`// them on the client side without your team's PII policy.`);
  lines.push("");
  if (schema.event_types.length === 0) {
    lines.push(`export type ${base} = Record<string, unknown>;`);
    return lines.join("\n");
  }
  const interfaceNames: string[] = [];
  for (const cluster of schema.event_types) {
    const slice = clusterSlice(schema, cluster);
    const ifaceName = `${base}_${tsIdentifier(cluster.name)}`;
    interfaceNames.push(ifaceName);
    lines.push(`export interface ${ifaceName} {`);
    const sensitiveSet = sensitivePaths(slice);
    // Flat fields only (skip $ and array-nested-only paths for clarity);
    // nested objects get represented at their leaf parents.
    const root = nestPaths(slice.fields);
    appendTsObject(lines, root, 1, sensitiveSet);
    lines.push(`}`);
    lines.push("");
  }
  if (interfaceNames.length === 1) {
    lines.push(`export type ${base} = ${interfaceNames[0]};`);
  } else {
    lines.push(`export type ${base} =`);
    interfaceNames.forEach((n, i) => {
      lines.push(`  | ${n}${i === interfaceNames.length - 1 ? ";" : ""}`);
    });
  }
  return lines.join("\n");
}

interface NestedNode {
  spec?: FieldSpec;
  children: Map<string, NestedNode>;
  isArrayElement?: boolean;
}

function nestPaths(fields: Record<string, FieldSpec>): NestedNode {
  const root: NestedNode = { children: new Map() };
  for (const [path, spec] of Object.entries(fields)) {
    if (path === "$") continue;
    const segments = path.split(".");
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
      const raw = segments[i]!;
      const isArr = raw.endsWith("[]");
      const key = isArr ? raw.slice(0, -2) : raw;
      let next = cur.children.get(key);
      if (!next) {
        next = { children: new Map(), isArrayElement: isArr };
        cur.children.set(key, next);
      } else if (isArr) {
        next.isArrayElement = true;
      }
      if (i === segments.length - 1) next.spec = spec;
      cur = next;
    }
  }
  return root;
}

function appendTsObject(
  lines: string[],
  node: NestedNode,
  depth: number,
  sensitive: Set<string>,
  path = "",
): void {
  const indent = "  ".repeat(depth);
  for (const [key, child] of node.children) {
    const fullPath = path ? `${path}.${key}` : key;
    const isOptional = child.spec ? !child.spec.required : true;
    const tagSensitive = sensitive.has(fullPath) ? " /* ▲ SENSITIVE */" : "";
    const opt = isOptional ? "?" : "";
    if (child.children.size > 0) {
      const arrSuffix = child.isArrayElement ? "[]" : "";
      lines.push(`${indent}${key}${opt}: {${tagSensitive}`);
      appendTsObject(lines, child, depth + 1, sensitive, fullPath);
      lines.push(`${indent}}${arrSuffix};`);
    } else {
      const types = child.spec?.types ?? ["string"];
      const tsUnion = uniqueSorted(types.map((t) => TYPE_MAP_TS[t] ?? "unknown")).join(
        " | ",
      );
      const arrSuffix = child.isArrayElement ? "[]" : "";
      lines.push(`${indent}${key}${opt}: ${tsUnion}${arrSuffix};${tagSensitive}`);
    }
  }
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

// ---------------------------------------------------------------------------
// JSON Schema (2020-12)
// ---------------------------------------------------------------------------

export function toJsonSchema(
  schema: InferredDataContract,
  context: ExportContext,
): Record<string, unknown> {
  const definitions: Record<string, unknown> = {};
  const oneOf: unknown[] = [];
  for (const cluster of schema.event_types) {
    const slice = clusterSlice(schema, cluster);
    const name = tsIdentifier(cluster.name);
    definitions[name] = clusterToJsonSchema(slice, context);
    oneOf.push({ $ref: `#/$defs/${name}` });
  }
  if (schema.event_types.length === 0) {
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: context.name,
      type: "object",
    };
  }
  if (oneOf.length === 1) {
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: context.name,
      $ref: (oneOf[0] as { $ref: string }).$ref,
      $defs: definitions,
    };
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: context.name,
    oneOf,
    $defs: definitions,
  };
}

function clusterToJsonSchema(
  slice: ClusterSchema,
  context: ExportContext,
): Record<string, unknown> {
  const sensitiveSet = sensitivePaths(slice);
  const root = nestPaths(slice.fields);
  return objectNodeToJsonSchema(root, "", sensitiveSet, context);
}

function objectNodeToJsonSchema(
  node: NestedNode,
  path: string,
  sensitive: Set<string>,
  context: ExportContext,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, child] of node.children) {
    const fullPath = path ? `${path}.${key}` : key;
    if (child.spec?.required) required.push(key);
    const spec = child.spec;
    let schema: Record<string, unknown>;
    if (child.children.size > 0) {
      const inner = objectNodeToJsonSchema(child, fullPath, sensitive, context);
      schema = child.isArrayElement ? { type: "array", items: inner } : inner;
    } else {
      const types = uniqueSorted(
        (spec?.types ?? ["string"]).map((t) => TYPE_MAP_JSON[t] ?? "string"),
      );
      schema = types.length === 1 ? { type: types[0]! } : { type: types };
      if (child.isArrayElement) schema = { type: "array", items: schema };
      if (spec?.enum_values && spec.enum_values.length > 0) {
        schema.enum = spec.enum_values;
      }
      if (spec?.numeric_range) {
        schema.minimum = spec.numeric_range.min;
        schema.maximum = spec.numeric_range.max;
      }
      if (spec?.examples && spec.examples.length > 0) {
        schema.examples = spec.examples;
      }
    }
    if (sensitive.has(fullPath)) {
      schema["x-sensitive"] = true;
    }
    properties[key] = schema;
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    title: context.name,
  };
}
