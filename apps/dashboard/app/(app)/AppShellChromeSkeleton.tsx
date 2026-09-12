import { NavigationProgress } from "../_components/NavigationProgress";
import Link from "next/link";
import { Activity } from "lucide-react";
import { AppNav } from "../AppNav";
import { Logo } from "../_brand/Logo";
import { MobileSidebar } from "../_components/MobileSidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { KpiLoadingSurface } from "./dashboard/KpiLoadingSurface";
import { PrimaryChartLoadingSurface } from "./dashboard/PrimaryChartLoadingSurface";

/**
 * Match AppShell while requireSession() resolves. Navigation stays interactive
 * because it does not depend on workspace data.
 */
export function AppShellChromeSkeleton() {
  const sidebar = <FallbackSidebar />;

  return (
    <div
      className="flex min-h-svh bg-background text-foreground"
      role="status"
      aria-label="Loading workspace"
      aria-busy="true"
    >
      <NavigationProgress label="Loading workspace…" />
      <aside className="hidden md:sticky md:top-0 md:flex md:h-svh md:w-64 md:shrink-0 md:flex-col md:self-start md:border-r md:border-border md:bg-sidebar md:text-sidebar-foreground">
        {sidebar}
      </aside>
      <MobileSidebar>{sidebar}</MobileSidebar>

      <main className="flex min-w-0 flex-1 flex-col overflow-x-hidden">
        <div className="flex-1 px-4 py-4 pt-14 md:px-8 md:py-6 md:pt-6">
          {/* Match PageHeader geometry (mb-8 pb-6, no border, h1 ≈ h-9/h-10)
              so the body doesn't shift when the real header resolves. */}
          <div className="mb-8 flex flex-col gap-1.5 pb-6">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-9 w-48 md:h-10" />
            <Skeleton className="h-4 w-72" />
            <div
              data-dashboard-filters="loading"
              className="mt-2 flex flex-wrap gap-2"
              aria-label="Dashboard filters loading"
            >
              {["14d", "30d", "90d"].map((label) => (
                <Link
                  key={label}
                  href={label === "14d" ? "/dashboard" : `/dashboard?range=${label}`}
                  prefetch={false}
                  className="inline-flex h-8 items-center rounded-md border border-input px-3 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  {label}
                </Link>
              ))}
            </div>
          </div>
          <KpiLoadingSurface />
          <PrimaryChartLoadingSurface className="mt-6" />
        </div>
      </main>
    </div>
  );
}

function FallbackSidebar() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-col gap-3 px-3 pt-4 pb-3">
        <Link
          href="/dashboard"
          prefetch={false}
          className="flex items-center gap-2 px-1"
          aria-label="Axel home"
        >
          <Logo size={20} />
          <span className="text-sm font-semibold tracking-tight">Axel</span>
        </Link>
        {/* Match the real sidebar header heights so the nav list below doesn't
            jump when the workspace switcher + command hint hydrate (visible for
            the full cold-pool wait). WorkspaceSwitcher ≈ 44px, hint ≈ 36px. */}
        <Skeleton className="h-11 w-full rounded-md" />
        <Skeleton className="h-9 w-full rounded-lg" />
      </div>
      <div className="flex-1 overflow-y-auto px-3">
        <AppNav />
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-3 pt-3 pb-4">
        <div className="flex items-center justify-between gap-2 pl-1 pr-0.5">
          <a
            href="/status"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            aria-label="View system status (opens in new tab)"
          >
            <Activity className="size-3" aria-hidden="true" />
            System status
          </a>
          <Skeleton className="size-6 rounded-full" />
        </div>
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
  );
}
