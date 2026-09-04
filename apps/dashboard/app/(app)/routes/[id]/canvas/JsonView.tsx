"use client";

/**
 * Compact JSON renderer for the canvas preview panels. Pretty-prints
 * via JSON.stringify(value, null, 2) so the operator sees the same
 * shape they'd see in their destination logs.
 */
import { useMemo } from "react";

interface Props {
  value: unknown;
  label?: string;
  maxHeight?: number;
}

export function JsonView({ value, label, maxHeight = 160 }: Props) {
  const text = useMemo(() => safeStringify(value), [value]);
  return (
    <div className="rounded-md border border-border bg-muted/40 text-[11px]">
      {label ? (
        <div className="border-b border-border px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      ) : null}
      <pre
        className="overflow-auto p-2 font-mono leading-snug"
        style={{ maxHeight }}
      >
        {text}
      </pre>
    </div>
  );
}

function safeStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "// could not display this value";
  }
}
