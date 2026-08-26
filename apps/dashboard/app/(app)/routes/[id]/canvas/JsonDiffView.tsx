"use client";

/**
 * Side-by-side input/output JSON diff for the canvas inspector.
 * Computed via lib/json-diff.ts (pure, no server-only deps), so this
 * runs entirely in the browser as the sample changes.
 *
 * Visual model: two columns. Each row is a leaf path. Green = added,
 * red = removed, amber = changed, muted = same. A "changes only" toggle
 * collapses the same-rows for large payloads.
 */
import { useMemo, useState } from "react";
import { diffJson, summariseDiff, type DiffEntry } from "../../../../../lib/json-diff";

interface Props {
  before: unknown;
  after: unknown;
  maxHeight?: number;
}

export function JsonDiffView({ before, after, maxHeight = 220 }: Props) {
  const [changesOnly, setChangesOnly] = useState(false);
  const entries = useMemo(() => diffJson(before, after), [before, after]);
  const summary = useMemo(() => summariseDiff(entries), [entries]);
  const visible = useMemo(
    () => (changesOnly ? entries.filter((e) => e.kind !== "same") : entries),
    [entries, changesOnly],
  );

  return (
    <div className="rounded-md border border-border bg-muted/40 text-[11px]">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
          <span style={{ color: "#16a34a" }}>+{summary.added}</span>
          <span style={{ color: "#dc2626" }}>−{summary.removed}</span>
          <span style={{ color: "#ca8a04" }}>~{summary.changed}</span>
          <span className="text-muted-foreground">·{summary.same}</span>
        </div>
        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-muted-foreground">
          <input
            type="checkbox"
            className="size-3"
            checked={changesOnly}
            onChange={(e) => setChangesOnly(e.target.checked)}
          />
          changes only
        </label>
      </div>
      <div
        className="overflow-auto p-1.5 font-mono leading-snug"
        style={{ maxHeight }}
      >
        {visible.length === 0 ? (
          <span className="text-muted-foreground">no entries</span>
        ) : null}
        {visible.map((e, i) => (
          <DiffRow key={`${e.path}-${i}`} entry={e} />
        ))}
      </div>
    </div>
  );
}

function DiffRow({ entry }: { entry: DiffEntry }) {
  const color =
    entry.kind === "added"
      ? "#16a34a"
      : entry.kind === "removed"
        ? "#dc2626"
        : entry.kind === "changed"
          ? "#ca8a04"
          : undefined;
  const prefix =
    entry.kind === "added"
      ? "+ "
      : entry.kind === "removed"
        ? "− "
        : entry.kind === "changed"
          ? "~ "
          : "  ";
  const path = entry.path === "" ? "(root)" : entry.path;
  if (entry.kind === "same") {
    return (
      <div className="text-muted-foreground/70">
        {prefix}
        <span>{path}</span>: <span>{compact(entry.after ?? entry.before)}</span>
      </div>
    );
  }
  if (entry.kind === "added") {
    return (
      <div style={{ color }}>
        {prefix}
        {path}: {compact(entry.after)}
      </div>
    );
  }
  if (entry.kind === "removed") {
    return (
      <div style={{ color }}>
        {prefix}
        {path}: {compact(entry.before)}
      </div>
    );
  }
  // changed
  return (
    <div style={{ color }}>
      {prefix}
      {path}: {compact(entry.before)} → {compact(entry.after)}
    </div>
  );
}

function compact(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 60 ? `"${value.slice(0, 57)}…"` : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const out = JSON.stringify(value);
    return out.length > 80 ? `${out.slice(0, 77)}…` : out;
  } catch {
    return String(value);
  }
}
