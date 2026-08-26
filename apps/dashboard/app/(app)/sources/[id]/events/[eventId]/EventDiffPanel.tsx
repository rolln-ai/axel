"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Minus, GitCompareArrows } from "lucide-react";
import { diffJson, summariseDiff, type DiffEntry } from "../../../../../../lib/json-diff";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface Props {
  sourceId: string;
  before: { event_id: string; received_at: string; payload: unknown } | null;
  after: { event_id: string; received_at: string; payload: unknown };
}

/**
 * Inline diff renderer for AXE-55. Renders one row per leaf path —
 * green plus for added, red minus for removed, yellow tilde for
 * changed. Same-value paths are folded by default to keep the table
 * scanable; "Show unchanged" toggles the noise.
 */
export function EventDiffPanel({ sourceId, before, after }: Props) {
  const [showUnchanged, setShowUnchanged] = useState(false);

  const entries = useMemo<DiffEntry[]>(
    () => (before ? diffJson(before.payload, after.payload) : []),
    [before, after],
  );
  const summary = useMemo(() => summariseDiff(entries), [entries]);

  if (!before) {
    return (
      <p className="text-sm text-muted-foreground">
        No previous event from this source in the last 30 days. The diff appears once a second
        event lands.
      </p>
    );
  }

  const filtered = showUnchanged
    ? entries
    : entries.filter((e) => e.kind !== "same");
  // Empty diff edge case: payloads are identical.
  if (filtered.length === 0) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          Identical to the previous event from this source. Schema is stable.
        </p>
        <Button variant="ghost" size="sm" onClick={() => setShowUnchanged(true)}>
          Show all fields anyway
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-muted-foreground">vs.</span>
        <Link
          href={`/sources/${sourceId}/events/${before.event_id}`}
          className="font-mono text-foreground hover:underline"
        >
          {before.event_id.slice(0, 18)}…
        </Link>
        <span className="text-muted-foreground">
          received {receivedAtRelative(before.received_at, after.received_at)} earlier
        </span>
        <span className="ml-auto flex items-center gap-2">
          {summary.added > 0 && (
            <Badge variant="default" className="gap-1">
              <Plus className="size-2.5" /> {summary.added}
            </Badge>
          )}
          {summary.removed > 0 && (
            <Badge variant="destructive" className="gap-1">
              <Minus className="size-2.5" /> {summary.removed}
            </Badge>
          )}
          {summary.changed > 0 && (
            <Badge variant="secondary" className="gap-1">
              <GitCompareArrows className="size-2.5" /> {summary.changed}
            </Badge>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-muted-foreground">
            <input
              type="checkbox"
              checked={showUnchanged}
              onChange={(e) => setShowUnchanged(e.target.checked)}
              className="size-3.5 rounded border-input"
            />
            Show unchanged
          </label>
        </span>
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/30 text-[10px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="w-6 px-2 py-1.5"></th>
              <th className="px-2 py-1.5 text-left">Path</th>
              <th className="px-2 py-1.5 text-left">Before</th>
              <th className="px-2 py-1.5 text-left">After</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {filtered.map((entry, i) => (
              <tr key={`${entry.path}|${i}`} className="border-t border-border">
                <td className={`px-2 py-1 align-top text-center ${kindIconClass(entry.kind)}`}>
                  {kindIcon(entry.kind)}
                </td>
                <td className={`px-2 py-1 align-top break-all ${kindLabelClass(entry.kind)}`}>
                  {entry.path || "(root)"}
                </td>
                <td className="max-w-[20ch] px-2 py-1 align-top break-all text-muted-foreground">
                  {renderValue(entry.before)}
                </td>
                <td className={`max-w-[20ch] px-2 py-1 align-top break-all ${kindLabelClass(entry.kind)}`}>
                  {renderValue(entry.after)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function kindIcon(k: DiffEntry["kind"]): string {
  switch (k) {
    case "added": return "+";
    case "removed": return "−";
    case "changed": return "~";
    case "same": return "·";
  }
}

function kindIconClass(k: DiffEntry["kind"]): string {
  switch (k) {
    case "added": return "bg-green-500/10 text-green-600 dark:text-green-400";
    case "removed": return "bg-red-500/10 text-red-600 dark:text-red-400";
    case "changed": return "bg-yellow-500/10 text-yellow-600 dark:text-yellow-400";
    case "same": return "text-muted-foreground";
  }
}

function kindLabelClass(k: DiffEntry["kind"]): string {
  switch (k) {
    case "added": return "text-green-700 dark:text-green-300";
    case "removed": return "text-red-700 dark:text-red-300 line-through decoration-red-500/40";
    case "changed": return "text-yellow-700 dark:text-yellow-300";
    case "same": return "text-foreground";
  }
}

function renderValue(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.length > 80) return JSON.stringify(value.slice(0, 80) + "…");
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > 80 ? json.slice(0, 80) + "…" : json;
  } catch {
    return String(value);
  }
}

function receivedAtRelative(beforeIso: string, afterIso: string): string {
  // Both come from ClickHouse as `YYYY-MM-DD HH:MM:SS.mmm` (UTC).
  const norm = (s: string) => (s.includes("T") ? s : s.replace(" ", "T") + "Z");
  const ms = Math.max(0, new Date(norm(afterIso)).getTime() - new Date(norm(beforeIso)).getTime());
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
