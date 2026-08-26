/**
 * LocalTime — render a timestamp in the viewer's local timezone.
 *
 * Why a client component:
 *   Vercel renders SSR in UTC, so any server-side `new Date(x).toLocaleString()`
 *   call produces UTC text regardless of the visitor's timezone. The user
 *   reading the dashboard from MT (UTC-6) sees timestamps that are 6 hours
 *   ahead of "now" — confusing and wrong.
 *
 *   The browser knows the local zone, so we render UTC at SSR (so the markup
 *   ships with *something*), then swap to local time on mount. The server
 *   markup is fine for SEO/no-JS, and `suppressHydrationWarning` prevents
 *   React from complaining about the swap.
 *
 * Modes:
 *   - "datetime" (default): full date + time, e.g. "May 4, 2026, 8:42:11 AM"
 *   - "date": date only, e.g. "May 4, 2026"
 *   - "time": time only, e.g. "8:42:11 AM"
 *   - "relative": "5 minutes ago" (with `useEffect` interval to refresh)
 *
 * Usage:
 *   <LocalTime value={record.created_at} />
 *   <LocalTime value={record.created_at} mode="date" />
 *   <LocalTime value={record.created_at} mode="relative" />
 */
"use client";

import * as React from "react";

export type LocalTimeMode = "datetime" | "date" | "time" | "relative";

export interface LocalTimeProps {
  /** ISO 8601 timestamp string. */
  value: string;
  /** Format mode. Defaults to "datetime". */
  mode?: LocalTimeMode;
  /** Optional className for the wrapping <time> element. */
  className?: string;
}

function formatAbsolute(value: string, mode: LocalTimeMode, useLocalZone: boolean): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const opts: Intl.DateTimeFormatOptions = useLocalZone ? {} : { timeZone: "UTC" };

  switch (mode) {
    case "date":
      return d.toLocaleDateString(undefined, opts);
    case "time":
      return d.toLocaleTimeString(undefined, opts);
    case "datetime":
    default:
      return d.toLocaleString(undefined, opts);
  }
}

function formatRelative(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;

  const diffMs = Date.now() - d.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const sec = Math.round(abs / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return future ? `in ${sec}s` : `${sec}s ago`;

  const min = Math.round(sec / 60);
  if (min < 60) return future ? `in ${min}m` : `${min}m ago`;

  const hr = Math.round(min / 60);
  if (hr < 24) return future ? `in ${hr}h` : `${hr}h ago`;

  const day = Math.round(hr / 24);
  if (day < 30) return future ? `in ${day}d` : `${day}d ago`;

  // Anything older than a month, fall back to absolute date.
  return d.toLocaleDateString();
}

export function LocalTime({ value, mode = "datetime", className }: LocalTimeProps) {
  // SSR initial pass: render UTC so the markup is deterministic. Once
  // mounted, switch to the browser's local zone (or relative-time string,
  // which is also browser-clock-dependent and so must run after mount).
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  // For relative mode, refresh the displayed string every 30s so "5m ago"
  // doesn't get stale on long-lived dashboards.
  const [, force] = React.useReducer((x: number) => x + 1, 0);
  React.useEffect(() => {
    if (mode !== "relative") return undefined;
    const id = setInterval(force, 30_000);
    return () => clearInterval(id);
  }, [mode]);

  let text: string;
  if (mode === "relative") {
    text = mounted ? formatRelative(value) : formatAbsolute(value, "datetime", false);
  } else {
    text = formatAbsolute(value, mode, mounted);
  }

  return (
    <time
      dateTime={value}
      className={className}
      suppressHydrationWarning
    >
      {text}
    </time>
  );
}
