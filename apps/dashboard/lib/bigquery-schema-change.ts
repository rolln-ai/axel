import "server-only";
import { normalizeBqType, type BqSchemaField } from "@axel/shared";
import { BIGQUERY_API_ROOT } from "./bigquery-auth";
import {
  getBigQueryDestinationAccess,
  introspectBigQueryDestination,
} from "./destination-inspect";

const SAFE_PROJECT = /^[A-Za-z0-9._:-]+$/;
const SAFE_DATASET = /^[A-Za-z0-9_]{1,1024}$/;
const SAFE_TABLE = /^[A-Za-z0-9_-]{1,1024}$/;
const SAFE_FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/;
const QUERY_TIMEOUT_MS = 25_000;
const REQUEST_TIMEOUT_MS = 40_000;

const SCALAR_TYPES = new Set([
  "BIGNUMERIC",
  "BOOL",
  "BYTES",
  "DATE",
  "DATETIME",
  "FLOAT64",
  "GEOGRAPHY",
  "INT64",
  "INTERVAL",
  "JSON",
  "NUMERIC",
  "STRING",
  "TIME",
  "TIMESTAMP",
]);

export interface BigQuerySchemaChangePlan {
  changed: boolean;
  fieldPath: string;
  fromType: string;
  toType: string;
  rootField: string;
  sql: string | null;
}

export interface BigQuerySchemaChangeResult {
  changed: boolean;
  projectId: string;
  dataset: string;
  table: string;
  fieldPath: string;
  fromType: string;
  toType: string;
}

export function findBigQueryField(
  fields: BqSchemaField[],
  fieldPath: string,
): BqSchemaField | null {
  const segments = fieldPath.split(".").filter(Boolean);
  if (segments.length === 0) return null;
  let current = fields;
  let found: BqSchemaField | undefined;
  for (const segment of segments) {
    found = current.find((field) => field.name.toLowerCase() === segment.toLowerCase());
    if (!found) return null;
    current = found.fields ?? [];
  }
  return found ?? null;
}

/**
 * Build the only automatic destination-side widening Axel currently offers:
 * INT64 -> FLOAT64. It uses BigQuery's supported widening operation and
 * preserves incoming fractional values. Every identifier and every type
 * originates from a live tables.get response, but we still validate them
 * before emitting GoogleSQL so a malformed external schema can never become
 * executable SQL.
 */
export function planBigQueryFieldTypeChange(input: {
  projectId: string;
  dataset: string;
  table: string;
  fields: BqSchemaField[];
  fieldPath: string;
  fromType: string;
  toType: string;
}): BigQuerySchemaChangePlan {
  assertIdentifier(SAFE_PROJECT, input.projectId);
  assertIdentifier(SAFE_DATASET, input.dataset);
  assertIdentifier(SAFE_TABLE, input.table);

  const segments = input.fieldPath.split(".").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => !SAFE_FIELD.test(segment))) {
    throw new Error(`bigquery_schema_field_invalid:${input.fieldPath}`);
  }
  const fromType = normalizeBqType(input.fromType);
  const toType = normalizeBqType(input.toType);
  if (fromType !== "INT64" || toType !== "FLOAT64") {
    throw new Error(`bigquery_schema_widening_unsupported:${fromType}_to_${toType}`);
  }

  const rootIndex = input.fields.findIndex(
    (field) => field.name.toLowerCase() === segments[0]!.toLowerCase(),
  );
  if (rootIndex < 0) throw new Error(`bigquery_schema_field_missing:${input.fieldPath}`);
  const root = cloneField(input.fields[rootIndex]!);
  if (root.mode === "REPEATED") {
    throw new Error(`bigquery_schema_repeated_ancestor:${root.name}`);
  }

  let cursor = root;
  for (let index = 1; index < segments.length; index += 1) {
    if (normalizeBqType(cursor.type) !== "RECORD") {
      throw new Error(`bigquery_schema_non_record_ancestor:${segments.slice(0, index).join(".")}`);
    }
    if (cursor.mode === "REPEATED") {
      throw new Error(`bigquery_schema_repeated_ancestor:${segments.slice(0, index).join(".")}`);
    }
    const next = cursor.fields?.find(
      (field) => field.name.toLowerCase() === segments[index]!.toLowerCase(),
    );
    if (!next) throw new Error(`bigquery_schema_field_missing:${input.fieldPath}`);
    cursor = next;
  }

  if (cursor.mode === "REPEATED") {
    throw new Error(`bigquery_schema_repeated_field:${input.fieldPath}`);
  }
  const currentType = normalizeBqType(cursor.type);
  if (currentType === toType) {
    return {
      changed: false,
      fieldPath: input.fieldPath,
      fromType,
      toType,
      rootField: root.name,
      sql: null,
    };
  }
  if (currentType !== fromType) {
    throw new Error(`bigquery_schema_type_changed:${input.fieldPath}:${currentType}`);
  }
  cursor.type = toType;

  // This deliberately conservative renderer does not recreate nested NOT NULL
  // constraints. Refuse the rewrite instead of silently relaxing a REQUIRED
  // target or sibling while redefining the root column.
  if (segments.length > 1 && hasRequiredDescendant(root)) {
    throw new Error(`bigquery_schema_required_nested_field:${root.name}`);
  }

  const rootType = renderFieldType(root);
  const tableRef = quoteTableRef(input.projectId, input.dataset, input.table);
  return {
    changed: true,
    fieldPath: input.fieldPath,
    fromType,
    toType,
    rootField: root.name,
    sql: `ALTER TABLE ${tableRef} ALTER COLUMN ${quoteField(root.name)} SET DATA TYPE ${rootType}`,
  };
}

export async function widenBigQueryDestinationField(input: {
  destinationId: string;
  workspaceId: string;
  dataset: string;
  table: string;
  fieldPath: string;
  fromType: "INT64";
  toType: "FLOAT64";
}): Promise<BigQuerySchemaChangeResult> {
  const current = await introspectBigQueryDestination(
    input.destinationId,
    input.workspaceId,
    { dataset: input.dataset, table: input.table },
  );
  if (current.kind === "missing") throw new Error("bigquery_schema_table_missing");

  const access = await getBigQueryDestinationAccess(input.destinationId, input.workspaceId);
  const plan = planBigQueryFieldTypeChange({
    projectId: access.projectId,
    dataset: input.dataset,
    table: input.table,
    fields: current.fields,
    fieldPath: input.fieldPath,
    fromType: input.fromType,
    toType: input.toType,
  });
  if (plan.sql) {
    await runBigQueryDdl(access.projectId, access.accessToken, plan.sql);
  }

  const verified = await introspectBigQueryDestination(
    input.destinationId,
    input.workspaceId,
    { dataset: input.dataset, table: input.table },
  );
  const verifiedField = verified.kind === "schema"
    ? findBigQueryField(verified.fields, input.fieldPath)
    : null;
  if (!verifiedField || normalizeBqType(verifiedField.type) !== input.toType) {
    throw new Error("bigquery_schema_change_not_visible");
  }

  return {
    changed: plan.changed,
    projectId: access.projectId,
    dataset: input.dataset,
    table: input.table,
    fieldPath: input.fieldPath,
    fromType: input.fromType,
    toType: input.toType,
  };
}

interface BigQueryJobResponse {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  errors?: Array<{ message?: string; reason?: string }>;
  status?: { errorResult?: { message?: string; reason?: string }; errors?: Array<{ message?: string; reason?: string }> };
}

async function runBigQueryDdl(projectId: string, accessToken: string, query: string): Promise<void> {
  const initial = await bigQueryRequest(
    `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}/queries`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({ query, useLegacySql: false, timeoutMs: QUERY_TIMEOUT_MS }),
    },
  );
  assertBigQueryJobSuccess(initial.body);
  if (initial.body.jobComplete !== false) return;

  const jobId = initial.body.jobReference?.jobId;
  if (!jobId) throw new Error("bigquery_schema_change_incomplete");
  const location = initial.body.jobReference?.location;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const params = new URLSearchParams({ timeoutMs: "10000" });
    if (location) params.set("location", location);
    const polled = await bigQueryRequest(
      `${BIGQUERY_API_ROOT}/projects/${encodeURIComponent(projectId)}/queries/${encodeURIComponent(jobId)}?${params}`,
      accessToken,
      { method: "GET" },
    );
    assertBigQueryJobSuccess(polled.body);
    if (polled.body.jobComplete !== false) return;
  }
  throw new Error("bigquery_schema_change_incomplete");
}

async function bigQueryRequest(
  url: string,
  accessToken: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<{ body: BigQueryJobResponse }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init.method,
      redirect: "manual",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let body: BigQueryJobResponse = {};
    try {
      body = JSON.parse(text) as BigQueryJobResponse;
    } catch {
      // The HTTP status and bounded response text below remain actionable.
    }
    if (!response.ok) {
      throw new Error(`bigquery_schema_change_http_${response.status}:${text.slice(0, 1200)}`);
    }
    return { body };
  } finally {
    clearTimeout(timer);
  }
}

function assertBigQueryJobSuccess(body: BigQueryJobResponse): void {
  const error = body.status?.errorResult ?? body.errors?.[0] ?? body.status?.errors?.[0];
  if (error) {
    throw new Error(
      `bigquery_schema_change_failed:${error.reason ?? "unknown"}:${error.message ?? "BigQuery rejected the schema change."}`,
    );
  }
}

function renderFieldType(field: BqSchemaField): string {
  const normalized = normalizeBqType(field.type);
  let type: string;
  if (normalized === "RECORD") {
    if (!field.fields || field.fields.length === 0) {
      throw new Error(`bigquery_schema_empty_record:${field.name}`);
    }
    type = `STRUCT<${field.fields.map((child) => `${quoteField(child.name)} ${renderFieldType(child)}`).join(", ")}>`;
  } else {
    if (!SCALAR_TYPES.has(normalized)) {
      throw new Error(`bigquery_schema_type_unsupported:${normalized}`);
    }
    type = normalized;
  }
  return field.mode === "REPEATED" ? `ARRAY<${type}>` : type;
}

function hasRequiredDescendant(field: BqSchemaField): boolean {
  return (field.fields ?? []).some(
    (child) => child.mode === "REQUIRED" || hasRequiredDescendant(child),
  );
}

function cloneField(field: BqSchemaField): BqSchemaField {
  return {
    ...field,
    ...(field.fields ? { fields: field.fields.map(cloneField) } : {}),
  };
}

function quoteTableRef(projectId: string, dataset: string, table: string): string {
  return `\`${projectId}.${dataset}.${table}\``;
}

function quoteField(field: string): string {
  if (!SAFE_FIELD.test(field)) throw new Error(`bigquery_schema_field_invalid:${field}`);
  return `\`${field}\``;
}

function assertIdentifier(pattern: RegExp, value: string): void {
  if (!pattern.test(value)) throw new Error(`identifier_rejected:${value}`);
}
