/**
 * Pure JSON tree diff — used by the AXE-55 live event diff viewer.
 *
 * Returns a flat list of paths annotated with the kind of change.
 * Recursive over plain objects and arrays. Bounded by `MAX_DEPTH` so
 * a hostile-shaped payload can't recurse forever.
 *
 * For arrays: we pair-up by index. That's good enough for the event-
 * diff use case (consecutive events from the same source usually
 * preserve array order); a smarter id-based pairing is a follow-up.
 */

export type DiffKind = "added" | "removed" | "changed" | "same";

export interface DiffEntry {
  path: string;
  kind: DiffKind;
  /** The value as it was in the previous event (B), `undefined` for `added`. */
  before?: unknown;
  /** The value as it is in the current event (A), `undefined` for `removed`. */
  after?: unknown;
}

const MAX_DEPTH = 32;

/**
 * Compare two JSON-like values. `before` is the older event, `after`
 * is the current. Returns one DiffEntry per leaf (and one per object
 * for added/removed sub-trees so the renderer can render the whole
 * branch at once).
 */
export function diffJson(before: unknown, after: unknown): DiffEntry[] {
  const out: DiffEntry[] = [];
  walk(before, after, "", out, 0);
  return out;
}

function walk(
  before: unknown,
  after: unknown,
  path: string,
  out: DiffEntry[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    out.push({ path, kind: "changed", before, after });
    return;
  }

  if (deepEqual(before, after)) {
    out.push({ path, kind: "same", before, after });
    return;
  }
  // One side missing entirely → added/removed sub-tree.
  if (before === undefined) {
    out.push({ path, kind: "added", after });
    return;
  }
  if (after === undefined) {
    out.push({ path, kind: "removed", before });
    return;
  }

  const beforeIsObj = isPlainObject(before);
  const afterIsObj = isPlainObject(after);
  const beforeIsArr = Array.isArray(before);
  const afterIsArr = Array.isArray(after);

  // Type changed (object → array, string → number, etc.) → render as
  // a single 'changed' leaf rather than recursing across the boundary.
  if (beforeIsArr !== afterIsArr || beforeIsObj !== afterIsObj) {
    out.push({ path, kind: "changed", before, after });
    return;
  }

  if (beforeIsObj && afterIsObj) {
    const a = before as Record<string, unknown>;
    const b = after as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      walk(a[k], b[k], path === "" ? k : `${path}.${k}`, out, depth + 1);
    }
    return;
  }

  if (beforeIsArr && afterIsArr) {
    const a = before as unknown[];
    const b = after as unknown[];
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      walk(a[i], b[i], `${path}[${i}]`, out, depth + 1);
    }
    return;
  }

  out.push({ path, kind: "changed", before, after });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
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
  const av = a as Record<string, unknown>;
  const bv = b as Record<string, unknown>;
  const ak = Object.keys(av);
  const bk = Object.keys(bv);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!deepEqual(av[k], bv[k])) return false;
  }
  return true;
}

export interface DiffSummary {
  added: number;
  removed: number;
  changed: number;
  same: number;
}

export function summariseDiff(entries: DiffEntry[]): DiffSummary {
  const out: DiffSummary = { added: 0, removed: 0, changed: 0, same: 0 };
  for (const e of entries) out[e.kind] += 1;
  return out;
}
