import { formatCount } from "../../../../lib/usage";
import type { ResponseCodeBucket } from "../../../../lib/destination-metrics";

/**
 * Horizontal bar chart of failed response-code / error buckets, ranked by count.
 * Each bucket gets a coloured bar tinted by tone.
 */
export function ResponseCodeBreakdown({ buckets }: { buckets: ResponseCodeBucket[] }) {
  if (buckets.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
        <small className="text-sm text-muted-foreground">
          No failures recorded in the last 24 hours.
        </small>
      </div>
    );
  }

  const total = buckets.reduce((acc, b) => acc + b.count, 0);
  const max = buckets.reduce((acc, b) => Math.max(acc, b.count), 0);

  return (
    <div className="space-y-2">
      {buckets.slice(0, 10).map((bucket) => {
        const widthPct = max > 0 ? (bucket.count / max) * 100 : 0;
        const sharePct = total > 0 ? (bucket.count / total) * 100 : 0;
        const fillClass =
          bucket.tone === "success"
            ? "bg-emerald-500/70"
            : bucket.tone === "warn"
              ? "bg-amber-500/70"
              : bucket.tone === "error"
                ? "bg-rose-500/70"
                : "bg-muted-foreground/40";
        return (
          <div
            key={bucket.bucket}
            className="grid grid-cols-[160px_1fr_140px] items-center gap-3"
          >
            <div className="truncate font-mono text-xs text-foreground" title={bucket.bucket}>
              {bucket.bucket}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <div
                className={`h-full ${fillClass}`}
                style={{ width: `${widthPct.toFixed(1)}%` }}
              />
            </div>
            <div className="text-right">
              <strong className="font-mono text-sm font-semibold text-foreground">
                {formatCount(bucket.count)}
              </strong>
              <small className="ml-2 text-xs text-muted-foreground">
                {sharePct.toFixed(sharePct >= 10 ? 0 : 1)}%
              </small>
            </div>
          </div>
        );
      })}
      {buckets.length > 10 ? (
        <small className="block pt-1 text-xs text-muted-foreground">
          +{buckets.length - 10} more buckets not shown
        </small>
      ) : null}
    </div>
  );
}
