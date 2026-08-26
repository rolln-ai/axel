import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inner-segment loading for /sources/[id]/. Mirrors the real OverviewTab first
 * paint — header (with a status badge + action), a tall EventStreamChart card,
 * a 2/4-up StatCard grid, then the recent-events table — so the recent-events
 * section doesn't get shoved down when content streams. See dashboard CLS audit.
 */
export default function SourceDetailLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-4 flex flex-col gap-3 border-b border-border pb-5 md:flex-row md:items-end md:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-64 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-6 w-28 rounded-full" />
          <Skeleton className="h-8 w-32 rounded-lg" />
        </div>
      </div>

      {/* EventStreamChart card (h-48 bar area). */}
      <div className="mb-6 rounded-lg border border-border bg-card p-5" aria-hidden="true">
        <div className="mb-3 flex items-center justify-between">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="flex h-48 items-end gap-1.5">
          {Array.from({ length: 24 }).map((_, i) => (
            <span
              key={i}
              className="w-full flex-1 rounded-t-sm bg-muted-foreground/20"
              style={{ height: `${28 + ((i * 13) % 62)}%` }}
            />
          ))}
        </div>
      </div>

      {/* StatCard grid (grid-cols-2 lg:grid-cols-4). */}
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-[92px] rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="mt-2 h-7 w-20" />
            <Skeleton className="mt-2 h-3 w-24" />
          </div>
        ))}
      </div>

      {/* Recent events table. */}
      <section className="rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex flex-col">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="flex h-[52px] items-center gap-4 border-b border-border px-5 last:border-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-44 max-w-full" />
                <Skeleton className="h-3 w-28 max-w-full" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
