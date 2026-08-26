import { densifyDailySeries, formatCount } from "../../../../lib/usage";
import {
  formatLatency,
  type DailyDestinationDeliveryRow,
  type LatencyPercentiles,
} from "../../../../lib/destination-metrics";

const SPARK_W = 300;
const SPARK_H = 80;
const SPARK_PAD_X = 4;
const SPARK_PAD_Y = 8;

/**
 * P50/P95/P99/max latency cards plus a stacked sparkline showing P50 and P95
 * over the last 14 days. Uses a single SVG path per series; pure server render.
 */
export function LatencyProfile({
  percentiles,
  daily,
  days,
  timezone,
}: {
  percentiles: LatencyPercentiles;
  daily: DailyDestinationDeliveryRow[];
  days: number;
  timezone: string;
}) {
  if (percentiles.count === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center">
        <small className="text-sm text-muted-foreground">
          No latency data yet — destination has no successful or retry attempts in the window.
        </small>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_auto]">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <LatencyCell label="P50" value={formatLatency(percentiles.p50)} sub="median" />
        <LatencyCell label="P95" value={formatLatency(percentiles.p95)} sub="tail" />
        <LatencyCell label="P99" value={formatLatency(percentiles.p99)} sub="far tail" />
        <LatencyCell
          label="Max"
          value={formatLatency(percentiles.max)}
          sub={`${formatCount(percentiles.count)} samples`}
        />
      </div>
      <Sparkline daily={daily} days={days} timezone={timezone} />
    </div>
  );
}

function LatencyCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <article className="flex flex-col gap-1 rounded-lg border border-border bg-card p-4">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <strong className="font-mono text-xl font-semibold text-foreground">{value}</strong>
      <small className="text-xs text-muted-foreground">{sub}</small>
    </article>
  );
}

function Sparkline({
  daily,
  days,
  timezone,
}: {
  daily: DailyDestinationDeliveryRow[];
  days: number;
  timezone: string;
}) {
  const dense = densifyDailySeries(daily, days, (day) => ({
    day,
    success: 0,
    retry: 0,
    dead: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
  }), timezone);

  const max = Math.max(1, ...dense.map((r) => r.p95_latency_ms));
  const innerW = SPARK_W - 2 * SPARK_PAD_X;
  const innerH = SPARK_H - 2 * SPARK_PAD_Y;

  function pointAt(value: number, i: number): [number, number] {
    const x = SPARK_PAD_X + (i / Math.max(1, dense.length - 1)) * innerW;
    const y = SPARK_PAD_Y + innerH - (value / max) * innerH;
    return [x, y];
  }

  function pathFor(getter: (row: DailyDestinationDeliveryRow) => number): string {
    return dense
      .map((row, i) => {
        const [x, y] = pointAt(getter(row), i);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }

  const p50Path = pathFor((r) => r.p50_latency_ms);
  const p95Path = pathFor((r) => r.p95_latency_ms);

  return (
    <article className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Latency · {days}d
        </span>
        <div className="flex gap-3 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <i className="block h-0.5 w-3 bg-primary" aria-hidden="true" />
            P50
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="block h-0.5 w-3 bg-amber-500" aria-hidden="true" />
            P95
          </span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
        className="w-full"
        role="img"
        aria-label={`P50 and P95 latency over the last ${days} days`}
      >
        <path d={p95Path} className="fill-none stroke-amber-500" strokeWidth={1.5} />
        <path d={p50Path} className="fill-none stroke-primary" strokeWidth={1.5} />
      </svg>
      <small className="font-mono text-[10px] text-muted-foreground">
        max in window: {formatLatency(max)}
      </small>
    </article>
  );
}
