/**
 * AXE-32 — public status page. No auth, no PII, no workspace data.
 * Pings the ingest worker and delivery service health endpoints
 * and renders an at-a-glance "up / degraded / down" board so
 * customers can answer "is it me or Axel?" without opening a
 * support ticket.
 *
 * Synthetic checks run server-side on each page load (deliberately
 * fresh — no caching). For a CDN-cached version with shorter TTL,
 * wire the underlying `runStatusChecks` into a cron + KV.
 */

import {
  combineHealthStatus,
  describeStatus,
  getUptimeHistory,
  listComponentHealth,
  overallStatus,
  uptimeLabel,
  type ComponentStatus as HealthStatus,
} from "../../lib/component-health";
import { UptimeSparkline } from "../_components/UptimeSparkline";

export const dynamic = "force-dynamic";
export const revalidate = 0;

interface ComponentStatus {
  name: string;
  url: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

// AXE-audit-Sev2 — explicit env reads so a misconfigured deploy
// renders "unconfigured" instead of probing a stale prod default.
const INGEST_URL = process.env.NEXT_PUBLIC_AXEL_INGEST_URL ?? null;
const DELIVERY_URL = process.env.NEXT_PUBLIC_AXEL_DELIVERY_URL ?? null;

const COMPONENTS: ReadonlyArray<{ name: string; url: string | null }> = [
  { name: "Ingest (CF Worker)", url: INGEST_URL },
  { name: "Delivery service (Render)", url: DELIVERY_URL },
];

/**
 * Bound a server-component DB read so a hung pool (Supabase pooler
 * restart, network blip) can't take down the public /status page —
 * the page that exists for exactly this kind of moment. Rejects with
 * a labeled error after `ms`; the caller's `Promise.allSettled` then
 * falls back to the existing "no heartbeat data" branch.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

async function probe(url: string | null): Promise<Omit<ComponentStatus, "name">> {
  if (!url) {
    return {
      url: "(unconfigured)",
      ok: false,
      latencyMs: 0,
      detail: "NEXT_PUBLIC_AXEL_*_URL not set on this deployment.",
    };
  }
  const target = url.replace(/\/$/, "") + "/health";
  const started = Date.now();
  try {
    const response = await fetch(target, { method: "GET", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(4000) });
    await response.body?.cancel().catch(() => undefined);
    const ok = response.ok;
    return {
      url: target,
      ok,
      latencyMs: Date.now() - started,
      detail: `HTTP ${response.status}`,
    };
  } catch {
    return {
      url: target,
      ok: false,
      latencyMs: Date.now() - started,
      detail: "Health request failed.",
    };
  }
}

export default async function StatusPage() {
  // Two-channel health: synthetic probes (does /health 200 right
  // now?) PLUS per-worker heartbeats (is the work loop actually
  // ticking, or just the /health endpoint?). A worker can pass
  // /health while wedged on the consume path — the heartbeat row
  // catches that.
  //
  // Both run in parallel via `allSettled` so a slow DB doesn't take
  // down the probe results and vice-versa.
  const [probeSettled, healthSettled, uptimeSettled] = await Promise.allSettled([
    Promise.allSettled(
      COMPONENTS.map(async (c) => ({ ...(await probe(c.url)), name: c.name })),
    ),
    withTimeout(listComponentHealth(), 3000, "listComponentHealth"),
    withTimeout(getUptimeHistory(), 3000, "getUptimeHistory"),
  ]);
  const checks: ComponentStatus[] =
    probeSettled.status === "fulfilled"
      ? probeSettled.value.map((r, i) => {
          if (r.status === "fulfilled") return r.value;
          return {
            name: COMPONENTS[i]?.name ?? "unknown",
            url: COMPONENTS[i]?.url ?? "(unknown)",
            ok: false,
            latencyMs: 0,
            detail: "Health check failed.",
          };
        })
      : [];
  // The heartbeat list returns empty when the DB itself is down;
  // that's a major-outage signal by itself.
  const heartbeats = healthSettled.status === "fulfilled" ? healthSettled.value : [];
  const uptime = uptimeSettled.status === "fulfilled" ? uptimeSettled.value : new Map();
  const heartbeatOverall: HealthStatus =
    healthSettled.status === "fulfilled" ? overallStatus(heartbeats) : "red";
  const overall = combineHealthStatus(checks, heartbeatOverall);
  const allProbesDown = checks.length > 0 && checks.every((check) => !check.ok);
  const outageMessage = allProbesDown
    ? "Ingest and delivery health checks failed"
    : "Processing disruption: a worker is down or stalled";

  return (
    <main className="mx-auto min-h-screen max-w-3xl px-6 py-12">
      <header className="mb-8 space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Axel status</h1>
        <p className="text-sm text-muted-foreground">
          Current endpoint checks and worker heartbeats. Refresh to check again.
        </p>
      </header>

      <section
        className={`mb-6 rounded-lg border px-5 py-4 ${
          overall === "operational"
            ? "border-border bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
            : overall === "degraded"
            ? "border-border bg-amber-500/10 text-amber-600 dark:text-amber-400"
            : "border-border bg-destructive/10 text-destructive"
        }`}
      >
        <p className="text-base font-semibold">
          {overall === "operational"
            ? "All systems operational"
            : overall === "degraded"
            ? "Some checks are unavailable or delayed"
            : outageMessage}
        </p>
        <p className="mt-1 text-xs">
          Probed at <time>{new Date().toISOString()}</time>.
        </p>
      </section>

      <section className="mb-6 rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-5 py-3 text-sm font-semibold">
          Synthetic probes
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            Live HTTP /health checks
          </span>
        </h2>
        <ul>
          {checks.map((c) => (
            <li
              key={c.name}
              className="flex flex-col gap-2 border-b border-border px-5 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium text-foreground">{c.name}</span>
                <small className="break-all font-mono text-[11px] text-muted-foreground">{c.url}</small>
              </div>
              <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    c.ok
                      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                      : "bg-destructive/10 text-destructive"
                  }`}
                >
                  {c.ok ? "up" : "down"}
                </span>
                <small className="text-[11px] text-muted-foreground">
                  {c.latencyMs}ms · {c.detail}
                </small>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-card">
        <h2 className="border-b border-border px-5 py-3 text-sm font-semibold">
          Worker heartbeats
          <span className="ml-2 text-[11px] font-normal text-muted-foreground">
            Last self-report from each work loop
          </span>
        </h2>
        {heartbeats.length === 0 ? (
          <p className="px-5 py-3 text-xs text-muted-foreground">
            Worker health is unavailable. Workers may not have reported yet, or the
            dashboard cannot reach the database.
          </p>
        ) : (
          <ul>
            {heartbeats.map((h) => {
              const buckets = uptime.get(h.component) ?? [];
              const label = uptimeLabel(buckets);
              return (
                <li
                  key={h.component}
                  className="flex flex-col gap-2 border-b border-border px-5 py-3 last:border-b-0"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-sm font-medium text-foreground">{h.component}</span>
                      <small className="text-[11px] text-muted-foreground">
                        {h.last_seen
                          ? `last beat: ${h.last_seen} (${h.staleness_seconds ?? 0}s ago)`
                          : "no heartbeat yet"}
                      </small>
                    </div>
                    <div className="flex shrink-0 flex-col items-start gap-1 sm:items-end">
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                          h.status === "green"
                            ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                            : h.status === "yellow"
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : h.status === "red"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-muted text-muted-foreground"
                        }`}
                        title={describeStatus(h.status)}
                      >
                        {describeStatus(h.status)}
                      </span>
                      <small className="text-[11px] text-muted-foreground">
                        {label ?? `expected every ${h.expected_interval_seconds}s`}
                      </small>
                    </div>
                  </div>
                  {buckets.length > 0 ? <UptimeSparkline buckets={buckets} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="mt-8 text-xs text-muted-foreground">
        <p>
          This page is public. For workspace-scoped delivery health open the dashboard at{" "}
          <a className="underline hover:text-foreground" href="/destinations">
            /destinations
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
