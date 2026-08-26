"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { LocalTime } from "./LocalTime";

export type ReplayProgressState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ReplayJobProgressSnapshot {
  state: ReplayProgressState;
  total: number;
  settled: number;
  remaining: number;
  succeeded: number;
  failed: number;
  percent: number;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Determinate replay progress with server-driven polling. Each refresh reads
 * durable replay_request states; no client-side timer invents progress.
 */
export function ReplayJobProgressCard({
  progress,
  title = "Replaying unresolved failures",
  className = "mb-4",
}: {
  progress: ReplayJobProgressSnapshot;
  title?: string;
  className?: string;
}) {
  const router = useRouter();
  const active = progress.state === "pending" || progress.state === "running";

  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(handle);
  }, [active, router]);

  return (
    <div
      className={`${className} rounded-lg border border-border bg-muted/20 p-4`}
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge variant={jobStateVariant(progress.state)} className="capitalize">
            {progress.state}
          </Badge>
          <span className="text-sm font-medium text-foreground">
            {active ? title : "Replay finished"}
          </span>
        </div>
        {progress.startedAt ? (
          <small className="text-xs text-muted-foreground">
            started <LocalTime value={progress.startedAt} mode="relative" />
          </small>
        ) : null}
      </div>

      <div
        className="relative mt-3 h-2 w-full overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        aria-valuetext={`${progress.settled} of ${progress.total} replay requests processed`}
      >
        <div
          className="h-full bg-foreground transition-[width] duration-500"
          style={{ width: `${progress.percent}%` }}
        />
        {active && progress.percent === 0 ? (
          <div className="absolute inset-y-0 left-0 w-1/6 animate-pulse rounded bg-foreground/50" />
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {progress.settled.toLocaleString("en-US")} / {progress.total.toLocaleString("en-US")} processed ({progress.percent}%)
        </span>
        <span>{progress.succeeded.toLocaleString("en-US")} resolved</span>
        <span className={progress.failed > 0 ? "text-destructive" : undefined}>
          {progress.failed.toLocaleString("en-US")} still failing
        </span>
        <span>{progress.remaining.toLocaleString("en-US")} queued or in flight</span>
      </div>

      {active ? (
        <p className="mt-2 text-[11px] text-muted-foreground">
          Updating automatically as replay deliveries resolve.
        </p>
      ) : null}
    </div>
  );
}

function jobStateVariant(
  state: ReplayProgressState,
): "default" | "destructive" | "secondary" | "outline" {
  switch (state) {
    case "done":
      return "default";
    case "failed":
    case "cancelled":
      return "destructive";
    case "running":
      return "secondary";
    default:
      return "outline";
  }
}
