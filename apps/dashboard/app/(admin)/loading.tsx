import { Skeleton } from "@/components/ui/skeleton";

/**
 * Inner-segment loading for /admin/* navigation. When the user clicks a
 * link in the admin sidebar, Next.js immediately swaps the page content
 * for this skeleton while the next page's RSC streams in — keeps the
 * chrome (sidebar + header) mounted and gives instant feedback.
 *
 * Mirrors (app)/loading.tsx; admin lists are simpler so the skeleton is
 * a header + a small KPI grid + one table.
 */
export default function AdminLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>

      <div className="mb-6 flex flex-col gap-2 border-b border-border pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-3 w-24" />
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-16" />
        </div>
        <div className="flex flex-col gap-3 p-5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
