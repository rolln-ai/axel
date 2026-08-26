import Link from "next/link";
import { Webhook } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { RANGES } from "./dashboardRange";
import { KpiLoadingSurface } from "./KpiLoadingSurface";
import { PrimaryChartLoadingSurface } from "./PrimaryChartLoadingSurface";

export default function DashboardLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading dashboard metrics…</span>

      <div className="mb-8 flex flex-col gap-4 pb-6 md:flex-row md:items-end md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">Workspace overview</p>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground md:text-4xl">Overview</h1>
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/sources"
            prefetch={false}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            <Webhook className="size-3.5" />
            New source
          </Link>
          <div
            data-dashboard-filters="loading"
            className="inline-flex h-9 items-center overflow-hidden rounded-lg border border-input bg-background"
            aria-label="Dashboard time range"
          >
            {RANGES.map((range) => (
              <Link
                key={range.value}
                href={range.value === "14d" ? "/dashboard" : `/dashboard?range=${range.value}`}
                prefetch={false}
                className="inline-flex h-full items-center border-r border-border px-3 text-xs font-medium text-muted-foreground transition-colors last:border-0 hover:bg-accent hover:text-foreground"
              >
                {range.label.replace("Last ", "")}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <KpiLoadingSurface />

      <PrimaryChartLoadingSurface className="mt-6" />
    </div>
  );
}
