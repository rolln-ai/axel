"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  fetchDestinationEdaAction,
  type EdaActionError,
  type EdaActionResponse,
} from "../../../../lib/destination-eda-actions";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import type { EdaDimension, EdaPoint } from "../../../../lib/destination-metrics";

/**
 * Interactive EDA panel — pick a dimension (time / route / status / attempt #),
 * a metric (volume / latency / success rate), and a window. Re-fetches via
 * server action and re-renders Recharts.
 *
 * The whole thing is one client component because the chart is interactive
 * (tooltips, axis ticks) and the controls drive a refetch. The server action
 * keeps the heavy SQL on the server and validates inputs.
 */

type Metric = "volume" | "latency" | "success_rate";

const DIMENSION_OPTIONS: Array<{ value: EdaDimension; label: string; hint: string }> = [
  { value: "hour", label: "Time (hourly)", hint: "Trend over the window" },
  { value: "route", label: "Route", hint: "Which routes drive traffic" },
  { value: "status", label: "Outcome status", hint: "Success / failure split" },
  { value: "attempt_no", label: "Attempt #", hint: "How retries distribute" },
];

const METRIC_OPTIONS: Array<{ value: Metric; label: string }> = [
  { value: "volume", label: "Volume (attempts)" },
  { value: "latency", label: "Latency (avg + p95)" },
  { value: "success_rate", label: "Success rate" },
];

const WINDOW_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 24, label: "Last 24 hours" },
  { value: 24 * 7, label: "Last 7 days" },
  { value: 24 * 30, label: "Last 30 days" },
];

interface Props {
  destinationId: string;
  initialRows: EdaPoint[];
  initialDimension: EdaDimension;
  initialWindowHours: number;
}

export function EdaPanel({
  destinationId,
  initialRows,
  initialDimension,
  initialWindowHours,
}: Props) {
  const [dimension, setDimension] = useState<EdaDimension>(initialDimension);
  const [windowHours, setWindowHours] = useState<number>(initialWindowHours);
  const [metric, setMetric] = useState<Metric>("volume");
  const [rows, setRows] = useState<EdaPoint[]>(initialRows);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [didMount, setDidMount] = useState(false);

  // Re-fetch when dimension / window changes (skip the initial render — server
  // already prefetched those).
  useEffect(() => {
    if (!didMount) {
      setDidMount(true);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result: EdaActionResponse | EdaActionError = await fetchDestinationEdaAction(
        destinationId,
        dimension,
        windowHours,
      );
      if (result.ok) {
        setRows(result.rows);
      } else {
        setError(result.message);
        setRows([]);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dimension, windowHours]);

  const chartData = useMemo(() => prepareChartData(rows, dimension), [rows, dimension]);
  const totalAttempts = rows.reduce((acc, r) => acc + r.count, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <ControlSelect
          label="Group by"
          value={dimension}
          onChange={(v) => setDimension(v as EdaDimension)}
          options={DIMENSION_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />
        <ControlSelect
          label="Metric"
          value={metric}
          onChange={(v) => setMetric(v as Metric)}
          options={METRIC_OPTIONS}
        />
        <ControlSelect
          label="Window"
          value={String(windowHours)}
          onChange={(v) => setWindowHours(Number(v))}
          options={WINDOW_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
        />
      </div>

      <div className="text-xs text-muted-foreground">
        {DIMENSION_OPTIONS.find((d) => d.value === dimension)?.hint} ·{" "}
        <span className="font-mono">
          {totalAttempts.toLocaleString("en-US")} attempts in window
        </span>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="relative h-[320px] w-full rounded-lg border border-border bg-card p-3">
        {isPending ? <ChartSkeleton /> : null}
        {!isPending && chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <small className="text-sm text-muted-foreground">
              No data in this window for this grouping.
            </small>
          </div>
        ) : null}
        {!isPending && chartData.length > 0 ? (
          <ChartFor metric={metric} dimension={dimension} data={chartData} />
        ) : null}
      </div>
    </div>
  );
}

interface ChartRow {
  bucket: string;
  display: string;
  count: number;
  success: number;
  retry: number;
  dead: number;
  successRate: number;
  avgLatency: number;
  p95Latency: number;
}

function prepareChartData(rows: EdaPoint[], dimension: EdaDimension): ChartRow[] {
  return rows.map((row) => {
    const display =
      dimension === "hour" ? formatHourLabel(row.bucket) : truncate(statusDisplay(row.bucket), 24);
    const successRate = row.count > 0 ? (row.success / row.count) * 100 : 0;
    return {
      bucket: row.bucket,
      display,
      count: row.count,
      success: row.success,
      retry: row.retry,
      dead: row.dead,
      successRate,
      avgLatency: Math.round(row.avg_latency_ms),
      p95Latency: Math.round(row.p95_latency_ms),
    };
  });
}

function ChartFor({
  metric,
  dimension,
  data,
}: {
  metric: Metric;
  dimension: EdaDimension;
  data: ChartRow[];
}) {
  const categorical = dimension !== "hour";

  if (metric === "latency" && !categorical) {
    return (
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
          <XAxis
            dataKey="display"
            tick={{ fontSize: 11 }}
            className="fill-muted-foreground"
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `${v}ms`}
            className="fill-muted-foreground"
          />
          <Tooltip content={<EdaTooltip metric={metric} />} />
          <Line
            type="monotone"
            dataKey="avgLatency"
            name="avg"
            stroke="hsl(var(--primary, 217 91% 60%))"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="p95Latency"
            name="p95"
            stroke="#f59e0b"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    );
  }

  if (metric === "success_rate") {
    return (
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
          <XAxis
            dataKey="display"
            tick={{ fontSize: 11 }}
            angle={categorical ? -20 : 0}
            textAnchor={categorical ? "end" : "middle"}
            height={categorical ? 60 : 30}
            interval={0}
            className="fill-muted-foreground"
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `${v}%`}
            className="fill-muted-foreground"
          />
          <Tooltip content={<EdaTooltip metric={metric} />} />
          <Bar dataKey="successRate" name="success rate" radius={[2, 2, 0, 0]}>
            {data.map((entry, idx) => (
              <Cell
                key={idx}
                fill={
                  entry.successRate >= 99
                    ? "#10b981"
                    : entry.successRate >= 90
                      ? "#f59e0b"
                      : "#f43f5e"
                }
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (metric === "latency" && categorical) {
    return (
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
          <XAxis
            dataKey="display"
            tick={{ fontSize: 11 }}
            angle={-20}
            textAnchor="end"
            height={60}
            interval={0}
            className="fill-muted-foreground"
          />
          <YAxis
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => `${v}ms`}
            className="fill-muted-foreground"
          />
          <Tooltip content={<EdaTooltip metric={metric} />} />
          <Bar dataKey="avgLatency" name="avg" fill="hsl(217 91% 60%)" radius={[2, 2, 0, 0]} />
          <Bar dataKey="p95Latency" name="p95" fill="#f59e0b" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    );
  }

  // volume: success vs failure. Retry and terminal failure remain separate
  // internally so the chart can preserve severity while the UI language stays
  // outcome-oriented.
  return (
    <ResponsiveContainer>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-border/40" />
        <XAxis
          dataKey="display"
          tick={{ fontSize: 11 }}
          angle={categorical ? -20 : 0}
          textAnchor={categorical ? "end" : "middle"}
          height={categorical ? 60 : 30}
          interval={0}
          className="fill-muted-foreground"
        />
        <YAxis tick={{ fontSize: 11 }} className="fill-muted-foreground" />
        <Tooltip content={<EdaTooltip metric={metric} />} />
        <Bar dataKey="success" stackId="a" name="success" fill="#10b981" />
        <Bar dataKey="retry" stackId="a" name="failure (retry scheduled)" fill="#f59e0b" />
        <Bar dataKey="dead" stackId="a" name="failure" fill="#f43f5e" radius={[2, 2, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function EdaTooltip({
  metric,
  active,
  payload,
}: {
  metric: Metric;
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-mono text-foreground">{row.display}</div>
      {metric === "latency" ? (
        <>
          <Stat label="avg" value={`${row.avgLatency}ms`} />
          <Stat label="p95" value={`${row.p95Latency}ms`} />
        </>
      ) : null}
      {metric === "success_rate" ? (
        <Stat label="success rate" value={`${row.successRate.toFixed(2)}%`} />
      ) : null}
      <Stat label="attempts" value={row.count.toLocaleString("en-US")} />
      <Stat label="success" value={row.success.toLocaleString("en-US")} tone="success" />
      <Stat label="failure (retry scheduled)" value={row.retry.toLocaleString("en-US")} tone="warn" />
      <Stat label="failure" value={row.dead.toLocaleString("en-US")} tone="error" />
    </div>
  );
}

function statusDisplay(value: string): string {
  if (value === "dead") return "failure";
  if (value === "retry") return "failure (retry scheduled)";
  return value;
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "warn" | "error";
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
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${valueClass}`}>{value}</span>
    </div>
  );
}

function ControlSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function ChartSkeleton() {
  return (
    <div className="absolute inset-0 flex items-end gap-1 p-3">
      {Array.from({ length: 18 }).map((_, i) => (
        <Skeleton
          key={i}
          className="flex-1"
          style={{ height: `${30 + ((i * 13) % 60)}%` }}
        />
      ))}
    </div>
  );
}

function formatHourLabel(raw: string): string {
  // ClickHouse returns "2026-05-06 14:00:00.000"
  const parsed = raw.replace(" ", "T");
  const ts = Date.parse(parsed.endsWith("Z") ? parsed : `${parsed}Z`);
  if (!Number.isFinite(ts)) return raw;
  const d = new Date(ts);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const day = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  return `${day} ${hh}:00`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
