/**
 * Dashboard charts — server-rendered SVG, no client JS.
 * Bars expose immediate hover labels for per-day counts.
 */
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { DailyDeliveryRow, DailyUsageRow } from "../../../lib/usage";
import { formatBytes, formatCount } from "../../../lib/usage";

const HEIGHT = 240;
const TOP_PAD = 16;
const BOTTOM_PAD = 28;
const RIGHT_PAD = 8;
const LEFT_PAD = 36;
const BAR_GAP = 4;
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

export function OverviewChart({
  events,
  delivery,
  unresolvedFailures,
  chartDays,
}: {
  events: DailyUsageRow[] | null;
  delivery: DailyDeliveryRow[] | null;
  unresolvedFailures: number;
  chartDays: number;
}) {
  if (events?.length === 0 && delivery?.length === 0) {
    return (
      <div
        data-dashboard-primary-chart="ready"
        className="rounded-xl border border-border bg-card p-6 text-center"
      >
        <small className="text-sm text-muted-foreground">No activity in the last {chartDays} days.</small>
        <div className="mt-3">
          <Link
            href="/usage"
            prefetch={false}
            data-dashboard-primary-chart-action="ready"
            className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            Open usage
          </Link>
        </div>
      </div>
    );
  }

  const rows = (delivery ?? []).map((row) => ({
    day: row.day,
    success: row.success,
    failure: row.retry + row.dead,
  }));
  const eventTotals = (events ?? []).map((e) => e.events);
  const deliveryTotals = rows.map((d) => d.success + d.failure);
  const totalEvents = eventTotals.reduce((a, b) => a + b, 0);
  const totalBytes = (events ?? []).reduce((a, e) => a + e.bytes, 0);
  const totalDelivery = deliveryTotals.reduce((a, b) => a + b, 0);
  const totalSuccess = rows.reduce((a, d) => a + d.success, 0);
  const totalFailure = rows.reduce((a, d) => a + d.failure, 0);
  // "retry" = latest attempt is a retry (mid-backoff or held by a paused
  // destination); "dead" = terminally failed. Lumping them as "failed" made
  // 3 in-flight retries read like 3 losses next to "Unresolved failures: 0",
  // which counts something else entirely (dead letters).
  const totalRetrying = (delivery ?? []).reduce((a, d) => a + d.retry, 0);
  const totalDead = (delivery ?? []).reduce((a, d) => a + d.dead, 0);

  return (
    <div data-dashboard-primary-chart="ready" className="space-y-4">
      {events ? (
        <ChartCard
          gradientId="overview-events-gradient"
          highlightStyle="gradient"
          eyebrow={`Volume — last ${chartDays} days`}
          headline={`${formatCount(totalEvents)} events`}
          sub={`${formatBytes(totalBytes)} received`}
          ariaLabel="Daily events ingested"
          actionHref="/usage"
          actionLabel="Open usage"
          rows={events.map((row) => ({
            day: row.day,
            total: row.events,
            segments: [{ value: row.events, className: "fill-orange-500/80", label: "events", dotClass: "fill-orange-500", title: `${row.day}: ${formatCount(row.events)} events` }],
          }))}
          legends={[{ tone: "event", label: `Events (${formatCount(totalEvents)})` }]}
        />
      ) : (
        <UnavailableChartCard label="Volume" />
      )}
      {delivery ? (
        <ChartCard
          gradientId="overview-deliveries-gradient"
          highlightStyle="muted"
          eyebrow={`Deliveries — last ${chartDays} days`}
          headline={`${formatCount(totalDelivery)} deliveries`}
          sub={deliveryOutcomeSub(totalSuccess, totalRetrying, totalDead, unresolvedFailures)}
          ariaLabel="Daily delivery outcomes"
          actionHref="/deliveries"
          actionLabel="Open deliveries"
          rows={rows.map((row) => ({
            day: row.day,
            total: row.success + row.failure,
            segments: [
              { value: row.success, className: "fill-emerald-500/80", label: "success", dotClass: "fill-emerald-500", title: `${row.day}: ${formatCount(row.success)} successful` },
              { value: row.failure, className: "fill-rose-500/80", label: "failed", dotClass: "fill-rose-500", title: `${row.day}: ${formatCount(row.failure)} failed` },
            ],
          }))}
          legends={[
            { tone: "success", label: `Success (${formatCount(totalSuccess)})` },
            { tone: "dead", label: `Retrying or failed (${formatCount(totalFailure)})` },
          ]}
        />
      ) : (
        <UnavailableChartCard label="Delivery stats" />
      )}
    </div>
  );
}

function UnavailableChartCard({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>{label} is temporarily unavailable. Refresh in a moment.</span>
      <Link
        href={label === "Volume" ? "/usage" : "/deliveries"}
        prefetch={false}
        data-dashboard-primary-chart-action="degraded"
        className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
      >
        {label === "Volume" ? "Open usage" : "Open deliveries"}
      </Link>
    </div>
  );
}

function deliveryOutcomeSub(
  totalSuccess: number,
  totalRetrying: number,
  totalDead: number,
  unresolvedFailures: number,
): string {
  const parts = [`${formatCount(totalSuccess)} succeeded`];
  if (totalRetrying > 0) parts.push(`${formatCount(totalRetrying)} awaiting retry`);
  if (totalDead > 0) parts.push(`${formatCount(totalDead)} failed`);
  if (totalRetrying === 0 && totalDead === 0) parts.push("0 failed");
  if (unresolvedFailures > 0) {
    parts.push(`${formatCount(unresolvedFailures)} unresolved in the dead-letter queue`);
  }
  return parts.join(" · ");
}

interface ChartRow {
  day: string;
  total: number;
  segments: Array<{
    value: number;
    className: string;
    title: string;
    /** Short word shown in the hover breakdown, e.g. "success" / "failed". */
    label: string;
    /** Fill class for the breakdown's colour dot, e.g. "fill-emerald-500". */
    dotClass: string;
  }>;
}

function ChartCard({
  eyebrow,
  headline,
  sub,
  ariaLabel,
  rows,
  legends,
  gradientId,
  highlightStyle,
  actionHref,
  actionLabel,
}: {
  eyebrow: string;
  headline: string;
  sub: string;
  ariaLabel: string;
  actionHref: string;
  actionLabel: string;
  rows: ChartRow[];
  legends: Array<{ tone: "event" | "success" | "dead"; label: string }>;
  gradientId: string;
  highlightStyle: "gradient" | "muted";
}) {
  const yMax = Math.max(1, ...rows.map((row) => row.total));
  const innerW = WIDTH - LEFT_PAD - RIGHT_PAD;
  const innerH = HEIGHT - TOP_PAD - BOTTOM_PAD;
  const colWidth = innerW / Math.max(1, rows.length);
  const barWidth = Math.max(2, colWidth - BAR_GAP);
  const labelEvery = Math.max(1, Math.ceil(rows.length / 7));
  const focusIndex = rows.length - 1;
  const focusTotal = rows[focusIndex]?.total ?? 0;
  const focusY = TOP_PAD + innerH * (1 - focusTotal / yMax);
  const showFocusLine = focusTotal > 0;

  return (
    <div className="rounded-xl border border-border bg-card p-6">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            {eyebrow}
          </p>
          <strong className="font-mono text-3xl font-semibold tracking-tight text-foreground">
            {headline}
          </strong>
          <small className="text-xs text-muted-foreground">
            {sub}
          </small>
        </div>
        <div className="flex flex-col items-start gap-2 md:items-end">
          <Link
            href={actionHref}
            prefetch={false}
            data-dashboard-primary-chart-action="ready"
            className="text-xs font-medium text-foreground underline-offset-4 hover:underline"
          >
            {actionLabel}
          </Link>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
            {legends.map((legend) => (
              <Legend key={legend.label} tone={legend.tone} label={legend.label} />
            ))}
          </div>
        </div>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-60 w-full"
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity={1} />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity={0.25} />
          </linearGradient>
        </defs>

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
                className="stroke-border/40"
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

        {showFocusLine ? (
          <line
            x1={LEFT_PAD}
            x2={WIDTH - RIGHT_PAD}
            y1={focusY}
            y2={focusY}
            className="stroke-foreground/35"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        ) : null}

        {rows.map((row, i) => {
          const colX = LEFT_PAD + i * colWidth + BAR_GAP / 2;
          const totalH = (row.total / yMax) * innerH;
          const labelY = Math.max(TOP_PAD + 12, TOP_PAD + innerH - totalH - 10);
          const isFocus = i === focusIndex;
          let segmentTop = TOP_PAD + innerH;

          return (
            <g key={row.day} className="group">
              {row.segments.map((segment, segIdx) => {
                if (segment.value <= 0) return null;
                const segmentH = (segment.value / yMax) * innerH;
                const y = segmentTop - segmentH;
                segmentTop = y;
                const useGradient =
                  isFocus && highlightStyle === "gradient" && segIdx === 0;
                return (
                  <rect
                    key={segment.title}
                    x={colX}
                    y={y}
                    width={barWidth}
                    height={segmentH}
                    rx={2}
                    className={
                      useGradient
                        ? undefined
                        : cn(segment.className, !isFocus && "opacity-40")
                    }
                    fill={useGradient ? `url(#${gradientId})` : undefined}
                  >
                    <title>{segment.title}</title>
                  </rect>
                );
              })}

              <rect
                x={colX}
                y={TOP_PAD}
                width={barWidth}
                height={innerH}
                fill="transparent"
                pointerEvents="all"
              >
                <title>
                  {`${shortDay(row.day)} — ${row.segments.map((s) => `${formatCount(s.value)} ${s.label}`).join(", ")}`}
                </title>
              </rect>
              <HoverBreakdown
                x={colX + barWidth / 2}
                anchorY={labelY}
                day={shortDay(row.day)}
                segments={row.segments}
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

/**
 * Hover popup showing the per-day breakdown (one line per segment with a colour
 * dot), so the numbers — especially a small failure count that's invisible as a
 * bar segment — are always readable as text. Pure CSS group-hover, no client JS.
 */
function HoverBreakdown({
  x,
  anchorY,
  day,
  segments,
}: {
  x: number;
  anchorY: number;
  day: string;
  segments: ChartRow["segments"];
}) {
  const lineH = 15;
  const padX = 10;
  const padY = 7;
  const dot = 6;
  const dotGap = 6;
  const lines = segments.map((s) => `${formatCount(s.value)} ${s.label}`);
  const maxChars = Math.max(day.length, ...lines.map((l) => l.length + 2));
  const width = Math.min(WIDTH - 4, Math.max(80, maxChars * 6.2 + padX * 2 + dot + dotGap));
  const height = padY * 2 + lineH * (segments.length + 1);
  const top = Math.max(4, anchorY - height);
  // Keep the popup inside the chart viewBox horizontally.
  const left = Math.min(WIDTH - 2 - width, Math.max(2, x - width / 2));
  return (
    <g className="pointer-events-none opacity-0 transition-opacity group-hover:opacity-100">
      <rect
        x={left}
        y={top}
        width={width}
        height={height}
        rx={6}
        className="fill-popover stroke-border"
        strokeWidth={1}
      />
      <text
        x={left + padX}
        y={top + padY + 9}
        className="fill-popover-foreground font-mono text-[10px] font-semibold"
      >
        {day}
      </text>
      {segments.map((s, idx) => {
        const ly = top + padY + lineH * (idx + 1);
        return (
          <g key={s.title}>
            <rect x={left + padX} y={ly + 2} width={dot} height={dot} rx={1} className={s.dotClass} />
            <text
              x={left + padX + dot + dotGap}
              y={ly + 9}
              className="fill-popover-foreground font-mono text-[10px]"
            >
              {`${formatCount(s.value)} ${s.label}`}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Legend({ tone, label }: { tone: "event" | "success" | "dead"; label: string }) {
  const dotClass =
    tone === "event" ? "bg-orange-500" : tone === "success" ? "bg-emerald-500" : "bg-rose-500";
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={`size-2 rounded-sm ${dotClass}`} aria-hidden="true" />
      {label}
    </span>
  );
}
