import "server-only";
import {
  runTransform,
  type GeneratedFilter,
  type GeneratedTransform,
} from "@axel/shared";
import type { DestinationMapping } from "./destination-mapping";
import { redactFixturePayload } from "./fixture-redaction";
import type { InferredDataContract } from "./inference";
import type { SampledEvent } from "./sampler";

export type { GeneratedFilter, GeneratedTransform };
export { runFilter, runTransform } from "@axel/shared";

export interface CodegenOptions {
  /** When set, restrict to a specific subset of event types by cluster name. */
  selected_event_type_names?: string[];
}

/**
 * Generate filter + transform from an approved Data Contract + destination
 * mapping.
 */
export function generateRouteArtifacts(
  inferred: InferredDataContract,
  mapping: DestinationMapping,
  options: CodegenOptions = {},
): { filter: GeneratedFilter; transform: GeneratedTransform } {
  const filter = buildFilter(inferred, options.selected_event_type_names);
  const transform = buildTransform(mapping);
  return { filter, transform };
}

function buildFilter(
  inferred: InferredDataContract,
  selectedNames: string[] | undefined,
): GeneratedFilter {
  if (!selectedNames || selectedNames.length === 0) return { kind: "always" };
  // Find a status field that looks like the event-type discriminator.
  const typeField = inferred.status_fields.find((f) =>
    ["type", "event", "event_type", "action"].includes(
      f.path.split(".").pop() ?? "",
    ),
  );
  if (!typeField) return { kind: "always" };
  // Filter to clusters whose name maps to one of the selected names AND
  // whose name appears in observed values for the type field.
  const clusterNames = new Set(inferred.event_types.map((c) => c.name));
  const observed = new Set(typeField.values);
  const values = selectedNames.filter(
    (n) => clusterNames.has(n) && observed.has(n),
  );
  if (values.length === 0) return { kind: "always" };
  return { kind: "event_type_in", path: typeField.path, values };
}

function buildTransform(mapping: DestinationMapping): GeneratedTransform {
  if (mapping.kind === "postgres") {
    if (mapping.mode === "columns" && mapping.column_assignments) {
      return { kind: "select", assignments: mapping.column_assignments };
    }
    return {
      kind: "jsonb_blob",
      column: mapping.jsonb_column ?? "payload",
    };
  }
  if (mapping.kind === "mongodb") {
    if (mapping.projected_paths.length === 0 && !mapping.id_path) {
      return { kind: "passthrough" };
    }
    // Mongo projection is encoded as a select that builds a doc shape.
    const assignments: Record<string, string> = {};
    if (mapping.id_path) assignments._id = mapping.id_path;
    for (const path of mapping.projected_paths) assignments[path] = path;
    return { kind: "select", assignments };
  }
  if (mapping.kind === "bigquery") {
    // The BigQuery delivery binding performs typed-record shaping and schema
    // evolution. Keep the route payload intact for that connector.
    return { kind: "passthrough" };
  }
  // webhook
  if (mapping.body_strategy === "envelope") {
    return {
      kind: "envelope",
      event_type_path: "type",
      occurred_at_path: null,
    };
  }
  return { kind: "passthrough" };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface SyntheticFixture {
  source_event_id: string | null;
  event_type: string | null;
  input_payload: unknown;
  expected_output: unknown;
}

/**
 * Build a fixture for each distinct event-type cluster represented in the
 * samples — pick the first sample of that cluster and compute the expected
 * output with the generated transform. The activation gate later replays
 * the fixtures through the same runner to catch drift between codegen and
 * runtime.
 */
export function buildFixturesFromSamples(
  samples: SampledEvent[],
  inferred: InferredDataContract,
  transform: GeneratedTransform,
): SyntheticFixture[] {
  const clusterById = new Map(
    inferred.event_types.map((c) => [c.cluster_id, c.name]),
  );
  const seen = new Set<string>();
  const out: SyntheticFixture[] = [];
  for (const sample of samples) {
    if (seen.has(sample.shape_hash)) continue;
    seen.add(sample.shape_hash);
    // Redact PII before storing. The transform is structural, so the expected
    // output is computed from the redacted input and stays consistent while
    // keeping PII out of both the stored input and expected columns.
    const redactedInput = redactFixturePayload(sample.payload);
    out.push({
      source_event_id: sample.event_id,
      event_type: clusterById.get(sample.shape_hash) ?? null,
      input_payload: redactedInput,
      expected_output: runTransform(redactedInput, transform),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Activation gate
// ---------------------------------------------------------------------------

export interface FixtureRunResult {
  passed: number;
  failed: number;
  total: number;
  failures: Array<{
    source_event_id: string | null;
    expected: unknown;
    actual: unknown;
  }>;
  ran_at: string;
}

/**
 * Run all fixtures through the transform and compare to expected output.
 * Used by the activation gate — only Data Contract versions whose fixtures
 * 100% pass can be linked to a live route.
 */
export function runFixtures(
  fixtures: SyntheticFixture[],
  transform: GeneratedTransform,
): FixtureRunResult {
  const failures: FixtureRunResult["failures"] = [];
  let passed = 0;
  for (const fixture of fixtures) {
    const actual = runTransform(fixture.input_payload, transform);
    if (deepEqual(actual, fixture.expected_output)) {
      passed += 1;
    } else {
      failures.push({
        source_event_id: fixture.source_event_id,
        expected: fixture.expected_output,
        actual,
      });
    }
  }
  return {
    passed,
    failed: failures.length,
    total: fixtures.length,
    failures,
    ran_at: new Date().toISOString(),
  };
}

export function canActivate(result: FixtureRunResult): boolean {
  return result.total > 0 && result.failed === 0;
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  const bKeys = Object.keys(bo);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!deepEqual(ao[key], bo[key])) return false;
  }
  return true;
}
