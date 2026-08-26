import { ShieldAlert } from "lucide-react";
import { Logo } from "../_brand/Logo";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Static chrome shown while the (admin)/layout is resolving
 * `requireSuperAdmin()`. Mirrors the AppShell skeleton in (app)/ —
 * see AppShellChromeSkeleton for the rationale.
 *
 * Dimensions track AdminShell.tsx — md:w-64 sidebar, sticky-top.
 */
export function AdminShellChromeSkeleton() {
  return (
    <div
      className="flex min-h-svh bg-background text-foreground"
      role="status"
      aria-label="Loading admin workspace"
      aria-busy="true"
    >
      <span className="sr-only">Loading admin workspace…</span>
      <aside className="hidden md:sticky md:top-0 md:flex md:h-svh md:w-64 md:shrink-0 md:flex-col md:self-start md:border-r md:border-border md:bg-sidebar md:text-sidebar-foreground">
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex flex-col gap-3 px-3 pt-4 pb-3">
            <div className="flex items-center gap-2 px-1">
              <Logo size={20} />
              <span className="text-sm font-semibold tracking-tight">Axel</span>
              <span className="ml-1 inline-flex items-center gap-1 rounded-md bg-red-600/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-600">
                <ShieldAlert className="size-3" /> admin
              </span>
            </div>
            <div className="rounded-md border border-dashed border-border px-2 py-1.5 text-center text-[11px] text-muted-foreground">
              ← Back to dashboard
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-3" aria-hidden="true">
            <div className="flex flex-col gap-1">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-7 w-full rounded-md" />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2 border-t border-border px-3 pt-3 pb-4">
            <div className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5">
              <Skeleton className="size-6 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
            <Skeleton className="h-7 w-full rounded-md" />
          </div>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <div className="flex-1 px-4 py-4 md:px-8 md:py-6">
          <div className="mb-6 flex flex-col gap-2 border-b border-border pb-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-hidden="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-7 w-20" />
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
