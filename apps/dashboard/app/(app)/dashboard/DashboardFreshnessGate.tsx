"use client";

import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { useRouter } from "next/navigation";

const BACKGROUND_REFRESH_MS = 30_000;

/**
 * Keep an open dashboard current with soft refreshes.
 *
 * router.refresh() re-renders the server tree in place: the cached data
 * helpers (unstable_cache, 60s revalidate) answer warm, content is never
 * hidden behind a skeleton, and no cache tags are invalidated.
 *
 * The previous version of this gate hid the page, evicted every workspace
 * cache tag via a server action, and re-rendered everything cold — twice per
 * visit, and again every 30 seconds against a 60-second cache TTL. The cache
 * never served a hit, so every view paid the cold ClickHouse KPI queries;
 * that was the root cause of the slow overview (ROL-627). Data staleness is
 * bounded by the helpers' own revalidate window, which is tighter than this
 * component ever needs to be.
 */
export function DashboardFreshnessGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const lastRefreshAtRef = useRef(Date.now());

  const refresh = useCallback(() => {
    lastRefreshAtRef.current = Date.now();
    router.refresh();
  }, [router]);

  // A restored snapshot (browser back/forward, bfcache) is the one path that
  // shows possibly-stale numbers without consulting the server. Refresh once.
  useEffect(() => {
    const nav = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (nav?.type === "back_forward") refresh();

    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) refresh();
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [refresh]);

  // Keep an open dashboard reasonably current. A hidden tab gains nothing
  // from an RSC round-trip every 30s, so skip ticks while backgrounded — the
  // visibilitychange effect below refreshes once when the tab regains focus.
  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      refresh();
    }, BACKGROUND_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  // Returning to a backgrounded tab is another common source of convincingly
  // stale numbers. Refresh when the last render is older than the cadence.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastRefreshAtRef.current < BACKGROUND_REFRESH_MS) return;
      refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [refresh]);

  return children;
}
