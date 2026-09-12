import { NavigationProgress } from "@/app/_components/NavigationProgress";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inner-segment loading for /deliveries/[id]/investigate. The page
 * shows the failing event header + attempt timeline + response body,
 * so this skeleton approximates that shape.
 */
export default function DeliveryInvestigateLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <NavigationProgress />

      <div className="mb-6 flex flex-col gap-2 border-b border-border pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-80" />
        <Skeleton className="h-4 w-64" />
      </div>

      <section className="rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-3 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="size-2 rounded-full" />
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card" aria-hidden="true">
        <Skeleton className="h-40 w-full rounded-lg" />
      </section>
    </div>
  );
}
