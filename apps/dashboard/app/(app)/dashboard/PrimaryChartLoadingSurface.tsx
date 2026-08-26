import { Skeleton } from "@/components/ui/skeleton";

// Mirrors ONE real ChartCard (OverviewChart.tsx): `rounded-xl border bg-card
// p-6`, an eyebrow/headline/sub header + legend, and an `h-60` (240px) chart
// area. Matching this height is what prevents the ~350px downward jump of the
// sections below when the real chart Suspense resolves.
function ChartCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-6" aria-hidden="true">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-3 w-28" />
        </div>
        <Skeleton className="h-3 w-24" />
      </div>
      {/* Bar area sized to the real ChartCard svg (h-60 = 240px). */}
      <div className="flex h-60 items-end gap-1.5 rounded-lg border border-border/60 bg-muted/20 px-3 pb-4 pt-8">
        {Array.from({ length: 14 }).map((_, i) => (
          <span
            key={i}
            className="w-full flex-1 rounded-t-sm bg-muted-foreground/20"
            style={{ height: `${32 + ((i * 17) % 58)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

// The real Overview chart (OverviewChart.tsx) is a `space-y-4` stack of TWO
// ChartCards (Volume + Deliveries). The loading surface must reserve the same
// two-card height so nothing below it shifts on resolve.
export function PrimaryChartLoadingSurface({ className = "" }: { className?: string }) {
  return (
    <section
      data-dashboard-primary-chart="loading"
      className={`space-y-4 ${className}`}
      aria-label="Primary chart loading"
      aria-busy="true"
    >
      <ChartCardSkeleton />
      <ChartCardSkeleton />
    </section>
  );
}
