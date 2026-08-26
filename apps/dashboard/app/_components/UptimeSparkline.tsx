import type { UptimeBucket } from "../../lib/component-health";

/**
 * 168-bar sparkline — one bar per hour over the last 7 days. Each
 * bar is a thin vertical div colour-coded to the bucket's status.
 * The first bar is 7 days ago; the last is the current hour.
 *
 * Pure server component — takes pre-fetched buckets, no JS, no
 * tooltips. Hovering reveals the ISO timestamp via the native
 * title attribute (browser tooltip). Operators wanting forensic
 * detail open /admin/health which has the full row.
 */
export function UptimeSparkline({ buckets }: { buckets: ReadonlyArray<UptimeBucket> }) {
  return (
    <div
      className="flex h-6 items-stretch gap-px overflow-hidden rounded"
      role="img"
      aria-label={`Uptime over the last ${buckets.length} hours`}
    >
      {buckets.map((b) => (
        <div
          key={b.bucket_start}
          title={`${b.bucket_start} — ${b.status}`}
          className={
            "flex-1 min-w-0 " +
            (b.status === "green"
              ? "bg-green-500/70"
              : b.status === "yellow"
              ? "bg-amber-500/70"
              : b.status === "red"
              ? "bg-red-500/70"
              : "bg-muted/60")
          }
        />
      ))}
    </div>
  );
}
