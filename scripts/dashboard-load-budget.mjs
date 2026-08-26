#!/usr/bin/env node

import http from "node:http";
import https from "node:https";
import { performance } from "node:perf_hooks";

const DEFAULT_URL = "http://localhost:3000/dashboard";
const USABLE_BUDGET_P75_MS = 2_000;
const USABLE_BUDGET_P95_MS = 5_000;
const PRIMARY_METRICS_BUDGET_P95_MS = 3_000;

const NAV_MARKER = 'data-dashboard-nav="ready"';
const FILTER_MARKERS = [
  'data-dashboard-filters="ready"',
  'data-dashboard-filters="loading"',
];
const PRIMARY_METRICS_READY_MARKER = 'data-dashboard-primary-metrics="ready"';
const PRIMARY_METRICS_DEGRADED_MARKER = 'data-dashboard-primary-metrics="degraded"';
const PRIMARY_METRICS_LOADING_MARKER = 'data-dashboard-primary-metrics="loading"';
const PRIMARY_METRIC_ACTION_MARKER = "data-dashboard-primary-metric-action=";
const PRIMARY_CHART_MARKERS = [
  'data-dashboard-primary-chart="ready"',
  'data-dashboard-primary-chart="degraded"',
  'data-dashboard-primary-chart="loading"',
];
const PRIMARY_CHART_ACTION_MARKER = "data-dashboard-primary-chart-action=";

function parseArgs(argv) {
  const args = {
    url: DEFAULT_URL,
    samples: 20,
    concurrency: 2,
    allowMissing: false,
  };
  const rest = argv.filter((arg) => arg !== "--");
  if (rest[0] && !rest[0].startsWith("--")) {
    args.url = rest.shift();
  }
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--samples") args.samples = Number(rest[++i]);
    else if (arg === "--concurrency") args.concurrency = Number(rest[++i]);
    else if (arg === "--allow-missing") args.allowMissing = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.samples) || args.samples < 1) {
    throw new Error("--samples must be a positive integer");
  }
  if (!Number.isInteger(args.concurrency) || args.concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  return args;
}

function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

function hasAnyMarker(body, markers) {
  return markers.some((marker) => body.includes(marker));
}

function hasUsableSurface(body) {
  return (
    body.includes(NAV_MARKER) &&
    hasAnyMarker(body, FILTER_MARKERS) &&
    hasAnyMarker(body, [
      PRIMARY_METRICS_READY_MARKER,
      PRIMARY_METRICS_DEGRADED_MARKER,
      PRIMARY_METRICS_LOADING_MARKER,
    ]) &&
    body.includes(PRIMARY_METRIC_ACTION_MARKER) &&
    hasAnyMarker(body, PRIMARY_CHART_MARKERS) &&
    body.includes(PRIMARY_CHART_ACTION_MARKER)
  );
}

function redirectedToLogin(res, body) {
  const location = res.headers.location;
  if (location) {
    try {
      return new URL(location, "http://localhost").pathname === "/login";
    } catch {
      return location.startsWith("/login");
    }
  }
  return body.includes("url=/login") || (body.includes('name="password"') && body.includes('href="/signup"'));
}

async function requestOnce(url, cookie) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const start = performance.now();

  return await new Promise((resolve, reject) => {
    const req = transport.request(
      target,
      {
        method: "GET",
        headers: {
          accept: "text/html,application/xhtml+xml",
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        let body = "";
        let usableAt = null;
        let navAt = null;
        let filtersAt = null;
        let primaryChartSurfaceAt = null;
        let primaryChartInteractiveAt = null;
        let primaryMetricsAt = null;
        let primaryMetricsSurfaceAt = null;
        let primaryMetricsInteractiveAt = null;
        const firstByteAt = performance.now() - start;

        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (navAt === null && body.includes(NAV_MARKER)) {
            navAt = performance.now() - start;
          }
          if (filtersAt === null && hasAnyMarker(body, FILTER_MARKERS)) {
            filtersAt = performance.now() - start;
          }
          if (
            primaryMetricsSurfaceAt === null &&
            (body.includes(PRIMARY_METRICS_READY_MARKER) ||
              body.includes(PRIMARY_METRICS_DEGRADED_MARKER) ||
              body.includes(PRIMARY_METRICS_LOADING_MARKER))
          ) {
            primaryMetricsSurfaceAt = performance.now() - start;
          }
          if (primaryMetricsInteractiveAt === null && body.includes(PRIMARY_METRIC_ACTION_MARKER)) {
            primaryMetricsInteractiveAt = performance.now() - start;
          }
          if (primaryMetricsAt === null && body.includes(PRIMARY_METRICS_READY_MARKER)) {
            primaryMetricsAt = performance.now() - start;
          }
          if (primaryChartSurfaceAt === null && hasAnyMarker(body, PRIMARY_CHART_MARKERS)) {
            primaryChartSurfaceAt = performance.now() - start;
          }
          if (primaryChartInteractiveAt === null && body.includes(PRIMARY_CHART_ACTION_MARKER)) {
            primaryChartInteractiveAt = performance.now() - start;
          }
          if (usableAt === null && hasUsableSurface(body)) {
            usableAt = performance.now() - start;
          }
        });
        res.on("end", () => {
          const totalMs = performance.now() - start;
          resolve({
            status: res.statusCode ?? 0,
            firstByteMs: firstByteAt,
            navMs: navAt,
            filtersMs: filtersAt,
            primaryMetricsMs: primaryMetricsAt,
            primaryMetricsSurfaceMs: primaryMetricsSurfaceAt,
            primaryMetricsInteractiveMs: primaryMetricsInteractiveAt,
            primaryChartSurfaceMs: primaryChartSurfaceAt,
            primaryChartInteractiveMs: primaryChartInteractiveAt,
            primaryMetricsDegraded: body.includes(PRIMARY_METRICS_DEGRADED_MARKER),
            primaryChartDegraded: body.includes('data-dashboard-primary-chart="degraded"'),
            usableMs: usableAt,
            totalMs,
            redirectedToLogin: redirectedToLogin(res, body),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function runPool(count, concurrency, task) {
  const results = [];
  let next = 0;
  async function worker() {
    while (next < count) {
      const index = next++;
      results[index] = await task(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
  return results;
}

function printMetric(label, values) {
  console.log(`${label}_p75_ms=${Math.round(percentile(values, 75))}`);
  console.log(`${label}_p95_ms=${Math.round(percentile(values, 95))}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookie = process.env.AXEL_DASHBOARD_COOKIE ?? "";
  const results = await runPool(args.samples, args.concurrency, () => requestOnce(args.url, cookie));

  const complete = results.filter((result) => result.status >= 200 && result.status < 400);
  const usable = complete.filter((result) => result.usableMs !== null);
  const primary = complete.filter((result) => result.primaryMetricsMs !== null);
  const nav = complete.filter((result) => result.navMs !== null);
  const filters = complete.filter((result) => result.filtersMs !== null);
  const primarySurface = complete.filter((result) => result.primaryMetricsSurfaceMs !== null);
  const primaryInteractive = complete.filter((result) => result.primaryMetricsInteractiveMs !== null);
  const chartSurface = complete.filter((result) => result.primaryChartSurfaceMs !== null);
  const chartInteractive = complete.filter((result) => result.primaryChartInteractiveMs !== null);
  const degraded = complete.filter((result) => result.primaryMetricsDegraded);
  const chartDegraded = complete.filter((result) => result.primaryChartDegraded);
  const loginRedirects = results.filter((result) => result.redirectedToLogin);

  console.log(`url=${args.url}`);
  console.log(`samples=${args.samples}`);
  console.log(`successful_http=${complete.length}`);
  console.log(`nav_samples=${nav.length}`);
  console.log(`filter_samples=${filters.length}`);
  console.log(`usable_samples=${usable.length}`);
  console.log(`primary_metric_surface_samples=${primarySurface.length}`);
  console.log(`primary_metric_interactive_samples=${primaryInteractive.length}`);
  console.log(`primary_metric_samples=${primary.length}`);
  console.log(`primary_metric_degraded_samples=${degraded.length}`);
  console.log(`primary_chart_surface_samples=${chartSurface.length}`);
  console.log(`primary_chart_interactive_samples=${chartInteractive.length}`);
  console.log(`primary_chart_degraded_samples=${chartDegraded.length}`);
  console.log(`login_redirect_samples=${loginRedirects.length}`);
  printMetric("first_byte", complete.map((result) => result.firstByteMs));
  printMetric("total", complete.map((result) => result.totalMs));
  if (nav.length > 0) printMetric("nav", nav.map((result) => result.navMs));
  if (filters.length > 0) printMetric("filters", filters.map((result) => result.filtersMs));
  if (usable.length > 0) printMetric("usable", usable.map((result) => result.usableMs));
  if (primarySurface.length > 0) {
    printMetric("primary_metric_surface", primarySurface.map((result) => result.primaryMetricsSurfaceMs));
  }
  if (primaryInteractive.length > 0) {
    printMetric("primary_metric_interactive", primaryInteractive.map((result) => result.primaryMetricsInteractiveMs));
  }
  if (chartSurface.length > 0) {
    printMetric("primary_chart_surface", chartSurface.map((result) => result.primaryChartSurfaceMs));
  }
  if (chartInteractive.length > 0) {
    printMetric("primary_chart_interactive", chartInteractive.map((result) => result.primaryChartInteractiveMs));
  }
  if (primary.length > 0) printMetric("primary_metrics", primary.map((result) => result.primaryMetricsMs));

  if (!args.allowMissing && loginRedirects.length > 0) {
    throw new Error("At least one sample redirected to login. Check AXEL_DASHBOARD_COOKIE.");
  }
  if (!args.allowMissing && usable.length !== args.samples) {
    throw new Error("Not every sample contained the dashboard usable markers. Check auth cookie and page output.");
  }
  if (!args.allowMissing && primary.length !== args.samples) {
    throw new Error("Not every sample contained real primary metric data. Check auth cookie, page output, and KPI query latency.");
  }

  const usableP75 = percentile(usable.map((result) => result.usableMs), 75);
  const usableP95 = percentile(usable.map((result) => result.usableMs), 95);
  const primaryP95 = percentile(primary.map((result) => result.primaryMetricsMs), 95);

  if (!args.allowMissing) {
    if (usableP75 > USABLE_BUDGET_P75_MS) {
      throw new Error(`Usable p75 ${Math.round(usableP75)}ms exceeds ${USABLE_BUDGET_P75_MS}ms`);
    }
    if (usableP95 > USABLE_BUDGET_P95_MS) {
      throw new Error(`Usable p95 ${Math.round(usableP95)}ms exceeds ${USABLE_BUDGET_P95_MS}ms`);
    }
    if (primaryP95 > PRIMARY_METRICS_BUDGET_P95_MS) {
      throw new Error(`Primary metrics p95 ${Math.round(primaryP95)}ms exceeds ${PRIMARY_METRICS_BUDGET_P95_MS}ms`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
