import { Skeleton } from "@/components/ui/skeleton";

const KPI_LABELS = [
  { label: "Events ingested", href: "/usage" },
  { label: "Deliveries", href: "/deliveries" },
  { label: "Success rate", href: "/deliveries" },
  { label: "Unresolved failures", href: "/deliveries" },
  { label: "Active sources", href: "/sources" },
];

export function KpiLoadingSurface() {
  return (
    <section
      data-dashboard-primary-metrics="loading"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
      aria-label="Primary metrics loading"
      aria-busy="true"
    >
      {/* Keep the streaming fallback synchronous: late client Link segments can
          target placeholders that the completed KPI boundary has removed. */}
      {KPI_LABELS.map((item) => (
        <a
          key={item.label}
          href={item.href}
          data-dashboard-primary-metric-action="loading"
          className="flex min-h-32 flex-col gap-2 rounded-xl border border-border bg-card p-5 transition-colors hover:border-foreground/20 hover:bg-accent/30"
        >
          <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
          <Skeleton className="h-10 w-24" />
          <Skeleton className="mt-1 h-3 w-20" />
        </a>
      ))}
    </section>
  );
}
