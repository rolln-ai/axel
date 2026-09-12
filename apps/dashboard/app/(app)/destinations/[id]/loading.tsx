import { NavigationProgress } from "@/app/_components/NavigationProgress";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Segment loading for /destinations/[id]/*. The detail layout's header AND the
 * tab navigation live in the sidebar (DetailSubnav), not in-content — so this
 * fallback fills only the content area and must mirror the real overview first
 * paint: a 3-up StatCard grid then the metrics region. (Earlier it rendered a
 * phantom in-content tab-pill strip that doesn't exist, causing an upward jump
 * on load. See dashboard CLS audit.)
 */
export default function DestinationDetailLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <NavigationProgress />

      {/* Top StatCard grid (destinations/[id]/page.tsx). */}
      <div className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-3" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-[88px] rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-16" />
          </div>
        ))}
      </div>

      {/* Metrics region — matches the page's OverviewSkeleton (h-44 + h-60). */}
      <div className="space-y-4" aria-hidden="true">
        <Skeleton className="h-44 w-full rounded-lg" />
        <Skeleton className="h-60 w-full rounded-lg" />
      </div>
    </div>
  );
}
