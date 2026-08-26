import type { ReactNode } from "react";

/**
 * Compact label / value / caption stat tile used on detail + usage pages.
 * Previously copied verbatim into three pages.
 */
export function StatCard({ label, value, sub }: { label: string; value: ReactNode; sub: string }) {
  return (
    <article className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <strong className="font-mono text-xl font-semibold text-foreground">{value}</strong>
      <small className="text-xs text-muted-foreground">{sub}</small>
    </article>
  );
}
