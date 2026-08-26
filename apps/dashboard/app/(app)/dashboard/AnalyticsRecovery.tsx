"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

const STORAGE_KEY = "axel.dashboard.analytics-recovery";
const RETRY_DELAY_MS = 4_000;
const MAX_REFRESHES_PER_WINDOW = 2;
const WINDOW_MS = 60_000;

/**
 * Rendered only while the KPI row's analytics series are unavailable
 * (the ClickHouse query outran its render budget). The query keeps
 * running server-side after the timeout and lands in unstable_cache,
 * so a soft refresh a few seconds later swaps the "—" placeholders for
 * real numbers without re-querying.
 *
 * Soft refresh only — never tag invalidation (that would evict the
 * cache and force the same slow cold query that degraded us). The
 * sessionStorage window caps refreshes so a persistently-down
 * ClickHouse can't put the page in a refresh loop.
 */
export function AnalyticsRecovery() {
  const router = useRouter();

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!takeRefreshSlot()) return;
      router.refresh();
    }, RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [router]);

  return null;
}

function takeRefreshSlot(): boolean {
  const now = Date.now();
  let count = 0;
  let windowStart = now;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { count?: number; windowStart?: number };
      if (typeof parsed.windowStart === "number" && now - parsed.windowStart < WINDOW_MS) {
        count = parsed.count ?? 0;
        windowStart = parsed.windowStart;
      }
    }
  } catch {
    // Session storage is only a loop guard. The refresh still works without it.
  }
  if (count >= MAX_REFRESHES_PER_WINDOW) return false;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ count: count + 1, windowStart }));
  } catch {
    // Same — guard only.
  }
  return true;
}
