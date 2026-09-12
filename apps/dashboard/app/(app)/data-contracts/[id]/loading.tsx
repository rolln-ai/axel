import { NavigationProgress } from "@/app/_components/NavigationProgress";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inner-segment loading for /data-contracts/[id]/. Data Contract detail
 * shows a header + event-cluster tabs + property table.
 */
export default function DataContractDetailLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <NavigationProgress />

      <div className="mb-6 flex flex-col gap-2 border-b border-border pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-56" />
      </div>

      {/* The contract's tabs live in the sidebar (DetailSubnav), not in-content
          — the previous in-content pill strip was phantom and slid the body up
          on load. Removed. See dashboard CLS audit. */}

      <section className="rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-3 p-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
