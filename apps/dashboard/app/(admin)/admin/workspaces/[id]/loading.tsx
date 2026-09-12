import { NavigationProgress } from "@/app/_components/NavigationProgress";
import { Skeleton } from "@/components/ui/skeleton";

/** Inner-segment loading for /admin/workspaces/[id]. */
export default function AdminWorkspaceDetailLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <NavigationProgress />

      <div className="mb-6 flex flex-col gap-2 border-b border-border pb-5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card" aria-hidden="true">
        <div className="border-b border-border px-5 py-3">
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="space-y-2 p-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </section>
    </div>
  );
}
