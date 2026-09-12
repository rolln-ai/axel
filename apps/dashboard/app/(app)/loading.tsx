import { NavigationProgress } from "@/app/_components/NavigationProgress";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeaderSkeleton } from "../_components/PageHeader";

// Shared fallback for the (app) list pages (sources, destinations, routes,
// team, notifications, inbox, …). These open with a TABLE card — NOT a KPI
// grid (only /dashboard renders KPIs, which has its own loading.tsx). So this
// reserves a header + a representative table, and nothing more, to avoid the
// phantom-KPI-row jump on every list navigation. See dashboard CLS audit.
export default function AppLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <NavigationProgress />

      <PageHeaderSkeleton actions={<Skeleton className="h-9 w-32 rounded-lg" />} />

      <section className="rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
        {/* Header row — shadcn TableHead is h-10. */}
        <div className="flex h-10 items-center gap-4 border-b border-border px-5">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
        {/* ~8 body rows at a representative height (stacked name + id + a badge)
            so the card reserves space rather than resizing when data loads. */}
        <div className="flex flex-col">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex h-[52px] items-center gap-4 border-b border-border px-5 last:border-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-48 max-w-full" />
                <Skeleton className="h-3 w-32 max-w-full" />
              </div>
              <Skeleton className="h-5 w-16 rounded-full" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
