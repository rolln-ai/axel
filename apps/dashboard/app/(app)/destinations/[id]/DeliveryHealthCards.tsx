import { formatCount } from "../../../../lib/usage";
import {
  formatLatency,
  formatRelative,
  type DeliveryWindowSummary,
} from "../../../../lib/destination-metrics";

/**
 * Six KPI cards: 24h and 7d windows, each showing total attempts, success rate,
 * and avg latency. Designed to mirror the StatCard pattern already on the page.
 */
export function DeliveryHealthCards({
  last24h,
  last7d,
}: {
  last24h: DeliveryWindowSummary;
  last7d: DeliveryWindowSummary;
}) {
  return (
    <div className="space-y-4">
      <WindowRow label="Last 24 hours" summary={last24h} />
      <WindowRow label="Last 7 days" summary={last7d} />
    </div>
  );
}

function WindowRow({ label, summary }: { label: string; summary: DeliveryWindowSummary }) {
  // Skips never reached the destination, so they say nothing about its
  // health — the rate is over attempts that were actually made.
  const realAttempts = summary.attempts - summary.skipped;
  const successPct = (summary.successRate * 100).toFixed(realAttempts > 1000 ? 2 : 1);
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {summary.lastAttemptAt ? (
          <span className="text-[11px] text-muted-foreground">
            last attempt {formatRelative(summary.lastAttemptAt)}
          </span>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Cell
          label="Attempts"
          value={formatCount(summary.attempts)}
          sub={
            summary.attempts === 0
              ? "no traffic"
              : summary.skipped > 0
                ? `${formatCount(summary.skipped)} skipped while paused`
                : ""
          }
          tone={summary.skipped > 0 ? "warn" : "neutral"}
        />
        <Cell
          label="Success rate"
          value={realAttempts > 0 ? `${successPct}%` : "—"}
          sub={
            realAttempts > 0
              ? `${formatCount(summary.success)} successful`
              : summary.skipped > 0
                ? "delivery paused"
                : ""
          }
          tone={successRateTone(summary, realAttempts)}
        />
        <Cell
          label="Failed attempts"
          value={formatCount(summary.retry + summary.dead)}
          sub={`${formatCount(summary.retry)} retried · ${formatCount(summary.dead)} terminal${
            summary.skipped > 0 ? ` · ${formatCount(summary.skipped)} skipped` : ""
          }`}
          tone={summary.dead > 0 ? "error" : summary.retry > 0 ? "warn" : "neutral"}
        />
        <Cell
          label="Avg latency"
          value={formatLatency(summary.avgLatencyMs)}
          sub="per attempt · excludes terminal + skipped"
        />
      </div>
    </div>
  );
}

function successRateTone(summary: DeliveryWindowSummary, realAttempts: number): CellTone {
  if (realAttempts === 0) return "neutral";
  if (summary.successRate >= 0.99) return "success";
  if (summary.successRate >= 0.9) return "warn";
  return "error";
}

type CellTone = "neutral" | "success" | "warn" | "error";

function Cell({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub: string;
  tone?: CellTone;
}) {
  const valueClass =
    tone === "success"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : tone === "error"
          ? "text-rose-600 dark:text-rose-400"
          : "text-foreground";
  return (
    <article className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <strong className={`font-mono text-xl font-semibold ${valueClass}`}>{value}</strong>
      <small className="text-xs text-muted-foreground">{sub || "\u00A0"}</small>
    </article>
  );
}
