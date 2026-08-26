import { densifyDailySeries, formatCount } from "../../../../lib/usage";
import type { DailyDestinationDeliveryRow } from "../../../../lib/destination-metrics";

const HEIGHT = 240;
const TOP_PAD = 16;
const BOTTOM_PAD = 28;
const RIGHT_PAD = 8;
const LEFT_PAD = 36;
const BAR_GAP = 6;
const WIDTH = 1100;

function compact(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

function shortDay(dayIso: string): string {
  const [, m, d] = dayIso.split("-");
  if (!m || !d) return dayIso;
  return `${Number(m)}/${Number(d)}`;
}

/**
 * Stacked-bar daily delivery chart for a single destination, mirroring the
 * pattern in components/dashboard/OverviewChart.tsx but with a single bar per
 * day (success+retry+dead stacked) since there's no "events ingested" series
 * at the destination level.
 */
export function DeliveryTimeSeriesChart({
  rows,
  days,
  timezone,
}: {
  rows: DailyDestinationDeliveryRow[];
  days: number;
  timezone: string;
}) {
  const dense = densifyDailySeries(rows, days, (day) => ({
    day,
    success: 0,
    retry: 0,
    dead: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
  }), timezone);

  const totals = dense.map((d) => d.success + d.retry + d.dead);
  const totalSuccess = dense.reduce((a, d) => a + d.success, 0);
  const totalFailure = dense.reduce((a, d) => a + d.retry + d.dead, 0);
  const grandTotal = totalSuccess + totalFailure;

  if (grandTotal === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
        <small className="text-sm text-muted-foreground">
          No delivery attempts in the last {days} days.
        </small>
      </div>
    );
  }

  const yMax = Math.max(1, ...totals);
  const innerW = WIDTH - LEFT_PAD - RIGHT_PAD;
  const innerH = HEIGHT - TOP_PAD - BOTTOM_PAD;
  const colWidth = innerW / dense.length;
  const barWidth = Math.max(2, colWidth - BAR_GAP);
  const labelEvery = Math.max(1, Math.ceil(dense.length / 7));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        <Legend tone="success" label={`Success (${formatCount(totalSuccess)})`} />
        <Legend tone="dead" label={`Failure (${formatCount(totalFailure)})`} />
      </div>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-60 w-full"
        role="img"
        aria-label={`Daily delivery outcomes for the last ${days} days`}
      >
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = TOP_PAD + innerH * (1 - frac);
          const value = Math.round(yMax * frac);
          return (
            <g key={frac}>
              <line
                x1={LEFT_PAD}
                x2={WIDTH - RIGHT_PAD}
                y1={y}
                y2={y}
                className="stroke-border/60"
                strokeWidth={1}
              />
              <text
                x={LEFT_PAD - 6}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-muted-foreground font-mono text-[10px]"
              >
                {compact(value)}
              </text>
            </g>
          );
        })}

        {dense.map((row, i) => {
          const colX = LEFT_PAD + i * colWidth + BAR_GAP / 2;
          const total = row.success + row.retry + row.dead;
          const totalH = (total / yMax) * innerH;
          const labelY = Math.max(TOP_PAD + 12, TOP_PAD + innerH - totalH - 8);
          const successH = (row.success / yMax) * innerH;
          const retryH = (row.retry / yMax) * innerH;
          const deadH = (row.dead / yMax) * innerH;
          const baseline = TOP_PAD + innerH;
          const successY = baseline - successH;
          const retryY = successY - retryH;
          const deadY = retryY - deadH;
          return (
            <g key={row.day} className="group">
              {row.success > 0 ? (
                <rect
                  x={colX}
                  y={successY}
                  width={barWidth}
                  height={successH}
                  className="fill-emerald-500/80"
                >
                  <title>{`${row.day}: ${row.success.toLocaleString()} successful`}</title>
                </rect>
              ) : null}
              {row.retry > 0 ? (
                <rect
                  x={colX}
                  y={retryY}
                  width={barWidth}
                  height={retryH}
                  className="fill-amber-500/80"
                >
                  <title>{`${row.day}: ${row.retry.toLocaleString()} failed, retry scheduled`}</title>
                </rect>
              ) : null}
              {row.dead > 0 ? (
                <rect
                  x={colX}
                  y={deadY}
                  width={barWidth}
                  height={deadH}
                  className="fill-rose-500/80"
                >
                  <title>{`${row.day}: ${row.dead.toLocaleString()} failed`}</title>
                </rect>
              ) : null}
              <rect
                x={colX}
                y={TOP_PAD}
                width={barWidth}
                height={innerH}
                fill="transparent"
                pointerEvents="all"
              >
                <title>{`${row.day}: ${formatCount(total)} delivery attempts`}</title>
              </rect>
              <HoverCountLabel
                x={colX + barWidth / 2}
                y={labelY}
                label={formatCount(total)}
              />
              {i % labelEvery === 0 ? (
                <text
                  x={colX + barWidth / 2}
                  y={HEIGHT - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground font-mono text-[10px]"
                >
                  {shortDay(row.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function HoverCountLabel({ x, y, label }: { x: number; y: number; label: string }) {
  const width = Math.max(42, label.length * 7 + 14);
  return (
    <g className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100">
      <rect
        x={x - width / 2}
        y={y - 15}
        width={width}
        height={18}
        rx={3}
        className="fill-popover stroke-border"
        strokeWidth={1}
      />
      <text
        x={x}
        y={y - 2}
        textAnchor="middle"
        className="fill-popover-foreground font-mono text-[10px] font-semibold"
      >
        {label}
      </text>
    </g>
  );
}

function Legend({ tone, label }: { tone: "success" | "retry" | "dead"; label: string }) {
  const dotClass =
    tone === "success" ? "bg-emerald-500" : tone === "retry" ? "bg-amber-500" : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`size-2 rounded-sm ${dotClass}`} aria-hidden="true" />
      {label}
    </span>
  );
}
