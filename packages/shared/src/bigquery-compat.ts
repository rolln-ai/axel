/**
 * Diff the BigQuery schema Axel would write (from expectedBigQuerySchema)
 * against an existing table's declared schema, to warn — before any delivery —
 * where incoming events won't fit. The headline case: Axel sends every scalar
 * as STRING, so a typed existing column (INT64/TIMESTAMP/…) is a conflict that
 * BigQuery would reject row-by-row.
 */
import type { BqSchemaField } from "./bigquery-shape.js";

export interface BqCompatIssue {
  /** Dotted field path, e.g. "data.subscriber.id". */
  path: string;
  kind: "type_conflict" | "mode_conflict" | "record_scalar_conflict" | "missing_required";
  /** What Axel will send for this field. */
  expected: string;
  /** The table's declared type/mode for this field. */
  existing: string;
  detail: string;
}

export interface BqCompatResult {
  /** True when there are no conflicts (any differences are purely additive). */
  compatible: boolean;
  conflicts: BqCompatIssue[];
  /** Field paths Axel will send that the table lacks (added automatically if IAM allows). */
  additions: string[];
  /** Table fields Axel won't populate — informational (they stay NULL). */
  unused: string[];
}

/** Normalize BigQuery's legacy type aliases to their standard-SQL names. */
export function normalizeBqType(type: string): string {
  switch (type.toUpperCase()) {
    case "INTEGER":
      return "INT64";
    case "FLOAT":
      return "FLOAT64";
    case "BOOLEAN":
      return "BOOL";
    case "STRUCT":
      return "RECORD";
    default:
      return type.toUpperCase();
  }
}

/**
 * Event-free heads-up: the existing table's leaf columns that are NOT STRING
 * (RECORDs are recursed into). Because Axel writes every scalar as STRING, these
 * are exactly the columns that would reject rows — useful when we can't sample
 * incoming events yet (e.g. a brand-new source in the wizard).
 */
export function typedColumns(fields: BqSchemaField[]): Array<{ path: string; type: string }> {
  const out: Array<{ path: string; type: string }> = [];
  const walk = (fs: BqSchemaField[], prefix: string): void => {
    for (const f of fs) {
      const path = prefix ? `${prefix}.${f.name}` : f.name;
      const t = normalizeBqType(f.type);
      if (t === "RECORD") {
        walk(f.fields ?? [], path);
        continue;
      }
      if (t !== "STRING") out.push({ path, type: t });
    }
  };
  walk(fields, "");
  return out;
}

export function compareBigQuerySchemas(
  expected: BqSchemaField[],
  existing: BqSchemaField[],
): BqCompatResult {
  const conflicts: BqCompatIssue[] = [];
  const additions: string[] = [];
  const unused: string[] = [];
  walk(expected, existing, "", conflicts, additions, unused);
  return { compatible: conflicts.length === 0, conflicts, additions, unused };
}

function walk(
  expected: BqSchemaField[],
  existing: BqSchemaField[],
  prefix: string,
  conflicts: BqCompatIssue[],
  additions: string[],
  unused: string[],
): void {
  const existingByName = new Map(existing.map((f) => [f.name.toLowerCase(), f]));
  const matchedExisting = new Set<string>();

  for (const exp of expected) {
    const path = prefix ? `${prefix}.${exp.name}` : exp.name;
    const cur = existingByName.get(exp.name.toLowerCase());
    if (!cur) {
      additions.push(path);
      continue;
    }
    matchedExisting.add(cur.name.toLowerCase());

    const expType = normalizeBqType(exp.type);
    const curType = normalizeBqType(cur.type);
    const curMode = cur.mode ?? "NULLABLE";

    // RECORD vs scalar (either direction) — a structural mismatch.
    if ((expType === "RECORD") !== (curType === "RECORD")) {
      conflicts.push({
        path,
        kind: "record_scalar_conflict",
        expected: `${exp.mode === "REPEATED" ? "REPEATED " : ""}${expType}`,
        existing: `${curMode === "REPEATED" ? "REPEATED " : ""}${curType}`,
        detail:
          expType === "RECORD"
            ? `Axel sends a nested object (RECORD) here, but the column is ${curType}.`
            : `Axel sends a ${expType} here, but the column is a nested RECORD.`,
      });
      continue;
    }

    if (expType === "RECORD" && curType === "RECORD") {
      if ((exp.mode === "REPEATED") !== (curMode === "REPEATED")) {
        conflicts.push(modeIssue(path, exp, curMode));
      }
      walk(exp.fields ?? [], cur.fields ?? [], path, conflicts, additions, unused);
      continue;
    }

    // Both scalar. Axel always sends STRING, so any non-STRING column conflicts.
    if (expType !== curType) {
      conflicts.push({
        path,
        kind: "type_conflict",
        expected: expType,
        existing: curType,
        detail:
          expType === "STRING"
            ? `Axel sends this value as STRING, but the column is ${curType} — BigQuery will reject the row.`
            : `Axel sends ${expType} but the column is ${curType}.`,
      });
      continue;
    }
    if ((exp.mode === "REPEATED") !== (curMode === "REPEATED")) {
      conflicts.push(modeIssue(path, exp, curMode));
    }
  }

  // Existing fields Axel won't populate. A REQUIRED one is a hard conflict.
  for (const cur of existing) {
    if (matchedExisting.has(cur.name.toLowerCase())) continue;
    const path = prefix ? `${prefix}.${cur.name}` : cur.name;
    if ((cur.mode ?? "NULLABLE") === "REQUIRED") {
      conflicts.push({
        path,
        kind: "missing_required",
        expected: "(not sent)",
        existing: `REQUIRED ${normalizeBqType(cur.type)}`,
        detail: `Column is REQUIRED but Axel won't send a value — inserts will fail.`,
      });
    } else {
      unused.push(path);
    }
  }
}

function modeIssue(path: string, exp: BqSchemaField, curMode: string): BqCompatIssue {
  return {
    path,
    kind: "mode_conflict",
    expected: `${exp.mode} ${normalizeBqType(exp.type)}`,
    existing: `${curMode} ${normalizeBqType(exp.type)}`,
    detail:
      exp.mode === "REPEATED"
        ? `Axel sends a repeated (array) value, but the column is not REPEATED.`
        : `Axel sends a single value, but the column is REPEATED (array).`,
  };
}
