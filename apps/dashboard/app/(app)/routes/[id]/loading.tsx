import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inner-segment loading for /routes/[id]/. Route detail shows a
 * header + filter/transform code blocks + destination wiring table.
 */
export default function RouteDetailLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-6 flex flex-col gap-2 border-b border-border pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-4 w-48" />
      </div>

      <section className="rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-3 p-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 flex-1" />
            </div>
          ))}
        </div>
      </section>

      {/* Pipeline canvas — reserve the real RoutePipelineCanvas footprint
          (height: calc(100dvh - 320px), minHeight: 520px) so the Raw-DSL
          section below it doesn't jump ~400px on resolve. See CLS audit. */}
      <section className="mt-6 rounded-lg border border-border bg-card p-3" aria-hidden="true">
        <div className="w-full" style={{ height: "calc(100dvh - 320px)", minHeight: 520 }}>
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      </section>
    </div>
  );
}
